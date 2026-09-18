# Tickets panel still presents remote attachments as local files

## Goal

Stop the Tickets panel from claiming a remote ticket attachment exists locally when it does not — and, when a copy genuinely was downloaded for *this* ticket, actually show it. Today the Attachments modal decides "is this downloaded?" by guessing a path from the remote filename inside a folder shared by every ticket in the list, so it reports false positives and opens the wrong file; and in the browser cockpit the modal is structurally incapable of showing anything at all.

### Problem

Open a ticket's Attachments modal. Attachments that live only on Linear/ClickUp are shown with a local `Path: …` line and `Open` / `Reveal` buttons — and those buttons open a *different ticket's* file. In the browser cockpit, the modal reports "No attachments found" for every ticket, and no remote image in a description renders.

### Root cause (confirmed against the code)

> *Line references below were re-verified against HEAD on 2026-08-08. `TaskViewerProvider.ts` has grown ~45 lines since this plan was first written; the numbers below are the current ones.*

Four separate mechanisms are involved — and one of the original draft's four was wrong. See the Superseded callout under mechanism 2.

**1. Local identity is guessed from the remote filename in a per-LIST folder, not a per-TICKET one.**

`TaskViewerProvider.getAttachmentList` (`src/services/TaskViewerProvider.ts:23620-23680`) builds the directory from the *currently selected* ClickUp hierarchy (`clickUp.getSelectedHierarchy()` → space/folder/list) or the Linear team + project, then:

```ts
const targetDir = path.join(baseDir, 'attachments');
…
const localPath = path.join(targetDir, filename);
const isDownloaded = fs.existsSync(localPath);
```

`filename` comes straight off the remote attachment (`attachment.filename || attachment.title || attachment.name`, line 23658). `downloadAttachment` (`TaskViewerProvider.ts:23507-23618`) writes into the same shared folder, and on collision renames the *new* file (`${parsed.name}-${Date.now()}${parsed.ext}`, lines 23563-23567), leaving the original in place.

Consequence: every ticket in a list shares one `attachments/` directory keyed only by filename. Ticket A downloads `image.png`. Ticket B's attachment is also called `image.png` — a different file on a different ticket. `getAttachmentList` for ticket B returns `isDownloaded: true` and `localPath` pointing at **ticket A's file**. `renderAttachmentsList` (`src/webview/tickets.js:2774-2837`) then renders `Open` / `Reveal` / `Path: …` for it. That is the reported symptom exactly: a remote attachment shown as a local file that is not it.

The directory derivation compounds it. Both writer and reader derive from `getSelectedHierarchy()` — the picker's *current* selection — not from the ticket's actual imported file. `_findTicketDocument` (`TaskViewerProvider.ts:21990-22030`) resolves the real path DB-first via the import registry, then scans every allowed root; `getAttachmentList` never consults it. In a subtask drill-down, or after the operator changes list/project, the derived folder has nothing to do with the ticket on screen.

**2. The inline image preview works in VS Code and is dead in the browser cockpit.**

> **Superseded:** *"The inline image preview is dead code. `src/webview/tickets.js:2816-2827` gates the inline `<img>` on `att.webviewUri` … `getAttachmentList`'s return type is `{ filename, url, localPath, isDownloaded }[]` — it never returns `webviewUri`. So the branch never runs: a downloaded image shows a path string and two buttons, never a preview."*
> **Reason:** Factually wrong at HEAD. `getAttachmentList` indeed never returns `webviewUri`, but it is not the last hop. `TicketsPanelProvider`'s `viewAttachments` arm already decorates the result — `TicketsPanelProvider.ts:2884-2896` maps over the array and, for image extensions, sets `att.webviewUri = targetPanel.webview.asWebviewUri(vscode.Uri.file(att.localPath)).toString()`. In the VS Code webview the preview branch fires today. The decoration is gated on `targetPanel && targetPanel.webview`, with an explicit comment citing host-agnosticism (contract #3) — so it is skipped for every headless/HTTP caller. The preview is dead **in the browser cockpit only**, and the cause is the panel gate, not a missing field.
> **Replaced with:** the defect is that the decoration has exactly one implementation — `asWebviewUri`, which requires a live VS Code webview. `TicketsPanelProvider._buildLocalAssetUrl` (`TicketsPanelProvider.ts:456-474`) already emits an allow-listed `http://127.0.0.1:<port>/design/asset?…` URL that satisfies **both** hosts, and `tickets.html`'s meta CSP already permits `http://127.0.0.1:*` for `img-src`. The fix is to prefer `_buildLocalAssetUrl` and keep `asWebviewUri` as the fallback for when no API server port is available — not to add a field that already exists.

**3. In the browser cockpit, remote images are blocked outright — but widening the CSP would not have helped.**

- `src/webview/tickets.html:23` (the meta CSP, used by the VS Code webview) allows `img-src {{WEBVIEW_CSP_SOURCE}} https: http://127.0.0.1:* http://localhost:* data: file:`.
- `src/services/headlessPanelHtml.ts:427` (`getTicketsHtml`, the browser cockpit) sends a **header** CSP of `img-src 'self' http://127.0.0.1:* http://localhost:* http://*.localhost:* data:` — no `https:`.

`LocalApiServer` sends that header on the panel response (`src/services/LocalApiServer.ts:830`). A browser enforces every delivered policy, so a resource must satisfy the header *and* the meta tag; the intersection wins and every `https://uploads.linear.app/…` / ClickUp CDN image is blocked in the cockpit. That description is accurate. The remedy originally proposed was not.

> **Superseded:** Widen `getTicketsHtml`'s `img-src` to include `https:`, "because ticket descriptions, comments and attachments reference remote provider CDNs (uploads.linear.app, ClickUp attachments)" — presented as the fix that lets the cockpit render remote attachment images.
> **Reason:** Web research (2026-08-08) settled the open question and disproved the premise. Neither provider serves workspace attachments as durable public URLs. **Linear**: `uploads.linear.app` requires `Authorization: Bearer <token>` and returns **HTTP 401** to an unauthenticated request; an `<img>` tag cannot send that header, so a plain `<img>` can never load one. Signed URLs are obtainable only by passing a `public-file-urls-expire-in: <seconds>` header on the GraphQL request, and they expire. **ClickUp**: "Private Attachment Links" is now enforced on all plans; attachment URLs are S3/CloudFront pre-signed and **expire after 60 minutes**, returning HTTP 403 thereafter. So the widening buys a permanent failure for Linear and a 60-minute one for ClickUp, in exchange for opening the cockpit DOM to arbitrary HTTPS origins named in ticket content. It is a weakened CSP that fixes nothing it was justified by.
> **Replaced with:** drop the CSP change from this plan. The cockpit's `img-src` stays as it is. The only images that can reliably render on either host are ones served from the local loopback asset route — which is exactly what `_buildLocalAssetUrl` already does and what the rest of this plan wires up. This is the "download-then-serve-locally" architecture the research identifies as the pattern Slack, Zapier and Notion all use for these providers.
>
> Consequence to state plainly rather than hide: an image in a ticket description hosted on some *other* public HTTPS origin (a company CDN, GitHub raw, imgur) remains blocked in the cockpit. Those would render if `https:` were allowed. That is a separate decision with a separate justification and is **not** made here — the provider-CDN rationale that was carrying it does not survive.

**3b. Attachment URLs are not stable identifiers.** A direct consequence of the same research, and it invalidates the original sidecar key. ClickUp returns a freshly pre-signed URL on every fetch (`…?X-Amz-Algorithm=…&X-Amz-Signature=…&X-Amz-Expires=…`), and Linear's signed URLs carry their own expiring signature. Keying a provenance record on `attachment.url` means the next list fetch presents a *different* string for the same file, the lookup misses, and `isDownloaded` flips back to false — reintroducing the "it forgot my download" symptom this plan exists to remove. Both providers do expose a stable `id` on the attachment object (`ClickUpSyncService.ts:1343`; `LinearSyncService.ts:1133-1140`, normalised at `:452`), so the key must be that id.

**4. The attachments verb is not wired into the standalone host at all — the browser cockpit's modal fakes success.**

`switchboard.getAttachmentList` and `switchboard.downloadAttachment` are registered **only** in `src/extension.ts` (lines 2096 and 2101) via `vscode.commands.registerCommand`. They are never registered into `switchboardCommandRegistry`, and `src/standalone/bootstrap.ts` registers only `refreshUI`, `focusTerminalByName`, `triggerAgentFromKanban`, `triggerBatchAgentFromKanban`, and three no-op reveal/open shims (lines 812-840). The bootstrap's own comment (lines 806-811) states the reach rule: registry-first, and *"an unregistered one falls through to vscodeShim's no-op."*

So in `npx switchboard`, `viewAttachments` resolves `result` to `undefined`. `Array.isArray(result)` is false, the decoration is skipped, and the arm returns:

```ts
{ type: 'attachmentsListResult', success: true, ticketId, attachments: undefined }
```

`renderAttachmentsList(undefined)` hits its `!attachments` guard (`tickets.js:2778`) and prints **"No attachments found."** for every ticket that has attachments. That is a `success: true` with no data — a direct violation of PRD contract #6 (*"never a stub that fakes success"*) and the Layer-2 half of contract #7. Widening the CSP without bridging these two commands fixes the *rendering* of a modal that never receives any rows.

## Metadata

- **Complexity:** 7
- **Tags:** frontend, backend, ui, bugfix, security
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 6
> **Reason:** The original score predated two findings: the standalone Layer-2 bridge (mechanism 4) adds a fifth file (`src/standalone/bootstrap.ts`) and a two-host completion obligation under PRD contract #7, and the `viewAttachments` decoration turns out to be a *replacement* of shipped behaviour with a live contract test pinning it (`verb-engine-tickets-headless.test.js:397-407`) rather than a greenfield addition. Provenance sidecar + shipped on-disk layout + CSP widening + cross-host wiring + a contract-test retarget is multi-file coordination with data-consistency risk on ~4,000 installs.
> **Replaced with:** **Complexity:** 7 → Lead Coder.

## User Review Required

None. The judgement calls are made and stated: (a) provenance goes in a per-directory sidecar JSON, not a `PlanningPanelCacheService` schema migration; (b) the sidecar is keyed on the attachment's **stable provider id**, never its URL, because both providers now re-sign attachment URLs per fetch; (c) the cockpit CSP is **left alone** — the research showed widening it cannot render provider attachments, so the local loopback route is the only path (see the Superseded callout under root cause 3); (d) the standalone bridge registers `getAttachmentList` and `downloadAttachment` only. `openAttachment` / `revealAttachment` are OS/editor actions with no headless meaning and stay unbridged — they are a capability-gating follow-up, not this plan's scope.

## Complexity Audit

### Routine
- The correct base directory is already resolvable: `path.dirname(await this._findTicketDocument(resolvedRoot, provider, id))` — the same helper `pushTicketEdits` uses (`TaskViewerProvider.ts:22041`).
- The dual-host URL helper already exists and is already used by this provider for inline ticket images (`TicketsPanelProvider.ts:456-474`, called at line 490), with its `realpathSync` + allow-listed-root traversal guard.
- The standalone bridge is two `switchboardCommandRegistry.register(...)` calls against the `taskViewerProvider` already constructed at `bootstrap.ts:725`.
- Both providers already expose a stable attachment `id` on the normalised object (`ClickUpSyncService.ts:1343`; `LinearSyncService.ts:452`), so the sidecar key needs no new API call — only plumbing it through the download button and message.

### Complex / Risky
- **On-disk attachment layout is shipped state.** Files already sit at `<listDir>/attachments/<filename>` on ~4k installs. Changing the download destination without a read-side fallback would make every previously-downloaded attachment invisible. The reader must consult the new provenance record *and* fall back to the legacy flat path.
- **Provenance must be recorded, not inferred.** As long as "is this downloaded?" is `fs.existsSync(guessedPath)`, the false positive returns the moment two tickets share a filename. The fix is to record what was downloaded for which ticket at download time, and read that record — a behavioural change, not a path tweak.
- **Sidecar vs. schema migration.** A new `attachments` table in `PlanningPanelCacheService` would need a schema migration on a published extension. A per-directory sidecar JSON needs none and is self-healing if deleted. Prefer the sidecar; it is strictly additive on disk.
- **A live contract test pins "headless ⇒ no `webviewUri`".** `src/test/verb-engine-tickets-headless.test.js:397-407` asserts `result.attachments[0].webviewUri === undefined` under the comment *"Headless has no webview → webviewUri must NOT be set (host-agnostic guard)."* That is precisely the behaviour this plan intends to change, so the assertion must be retargeted deliberately — see Verification.
- **`_buildLocalAssetUrl`'s allow-list does not cover a custom ticket save location.** It builds the allowed set from `getTicketsAssetRoots(root)` = `LocalFolderService.getTicketsFolderPaths()` + `getFolderPaths()` + `<root>/.switchboard/tickets` (`TicketsPanelProvider.ts:443-453`). `getTicketsFolderPaths()` reads the `ticketsFolderPaths` folder-config key (`LocalFolderService.ts:877-885`) — a *different* setting from `GlobalIntegrationConfigService`'s `ticketSaveLocation`, which is what `_buildTicketDir` actually writes to (`TaskViewerProvider.ts:21960-21971`). On any install with a custom `ticketSaveLocation` outside those roots, `_buildLocalAssetUrl` returns `undefined` and previews silently stay off in both hosts.
- **Attachment URLs are re-signed per fetch on both providers** (ClickUp pre-signed, 60-minute TTL; Linear signed-on-request). Any provenance keyed on the URL string breaks on the next list fetch. The sidecar key must be the stable attachment id, and the download button/message must carry it — a small plumbing change through `tickets.js` that is easy to miss and silently reintroduces the original symptom if skipped.
- **Two provider surfaces.** The modal renderer is `tickets.js`, but the data comes from a `TaskViewerProvider` command routed through `TicketsPanelProvider` (`viewAttachments` → `switchboard.getAttachmentList`, `TicketsPanelProvider.ts:2872-2919`). `_buildLocalAssetUrl` lives on `TicketsPanelProvider`, so the URL must be produced there, not in `TaskViewerProvider`.
- **Two hosts, two layers.** Per PRD contract #7 this verb is only done when the arm is host-agnostic and returns data (Layer 1) *and* the standalone host can actually execute the underlying command (Layer 2). Shipping either alone leaves the cockpit modal empty or the extension unchanged.

## Edge-Case & Dependency Audit

### Race Conditions
- **Sidecar concurrent writes.** Two downloads for different tickets in the same directory do read-modify-write on one `_attachments.json`. `downloadAttachment` is invoked per user click and the write is a synchronous `writeFileSync` of a small object, so the window is sub-millisecond — but a lost update is possible under a scripted burst. Accepted: the loss degrades to "that one attachment shows Download again", never to a wrong file, because the reader still `existsSync`-checks the recorded path. Do not add a lock.
- **Download-then-list.** The modal re-requests the list after a download completes (`attachmentDownloaded` → refresh). The sidecar write happens before `downloadAttachment` returns, so the subsequent list read always sees it.

### Security
- **Traversal:** `_buildLocalAssetUrl` already realpaths the target and rejects anything outside `getTicketsAssetRoots(root)` (lines 459-471); returning `undefined` from it must degrade to "no preview", never to an unguarded `file:` URL. Widening `getTicketsAssetRoots` with `ticketSaveLocation` (below) widens the allow-list by exactly the directory the extension itself writes tickets into — no user-supplied path is added.
- **`downloadAttachment`'s own path traversal guard** (`TaskViewerProvider.ts:23543-23547`) must be preserved verbatim when the target dir derivation changes, and must be re-anchored on the new base dir rather than the old one.
- **CSP:** unchanged by this plan. The originally proposed `img-src … https:` widening is cut (see root cause 3), so the cockpit's image-source surface does not grow and this plan makes no security-posture change at all.
- **Sidecar content is trusted only as a path hint.** Values are absolute paths written by this process; the reader must still `existsSync` them, and any path handed to `_buildLocalAssetUrl` is re-validated against the allow-list. A hand-edited sidecar cannot escape that gate.

### Side Effects
- **New file on disk.** `_attachments.json` appears inside each ticket's `attachments/` directory. It is additive, ignorable, and self-healing if deleted (the reader falls back to the legacy scan when it holds no record for the ticket).
- **Download destination moves** from `<listDir>/attachments/` to `<ticketDir>/attachments/` for tickets with a resolvable imported document. Old files stay where they are and remain reachable via the legacy fallback.
- **Standalone gains two working buttons.** After the bridge, Download and the attachments list function in `npx switchboard`; `Open`/`Reveal` remain no-ops there and should be treated as the next capability-gating item.

### Dependencies & Conflicts
- **Legacy downloads:** attachments downloaded before this change have no sidecar entry. The reader falls back to the legacy flat `existsSync` check **only when the sidecar has no record for this ticket at all**, so existing installs keep their Open/Reveal until the first new download writes provenance. Once provenance exists for a ticket, it is authoritative.
- **Filename collisions within one ticket:** `downloadAttachment` already timestamp-suffixes on collision; the sidecar records the *final* path, so the record stays correct where the guess never could.
- **Deleted files:** the reader still `existsSync`-checks the recorded path — a recorded-but-deleted file reports `isDownloaded: false` and offers Download again.
- **Remote-only attachments:** with no record and no legacy file, they render with a Download button and **no** `Path:` line and **no** Open/Reveal. This is the visible fix.
- **Ticket with no imported document:** `_findTicketDocument` returns `null` (never imported, or the file was deleted). The dir derivation must then fall back to the existing hierarchy path so behaviour is unchanged rather than throwing.
- **Linear auth:** the download path attaches the Linear API token for `.linear.app` assets (`TaskViewerProvider.ts:23569-23576`). Research confirms this is required, not defensive — `uploads.linear.app` returns 401 without it. Download-then-serve-locally is therefore the **only** route by which a Linear attachment can ever appear inline on either host. The UI must say that rather than implying an un-downloaded attachment might preview.
- **ClickUp link expiry:** a pre-signed ClickUp URL is dead 60 minutes after the list fetch that produced it. The `Open remote` anchor on a stale modal will 403. Not worth a guard — the operator's next list refresh re-signs it — but do not cache attachment URLs anywhere expecting them to keep working, and never store one as an identifier.
- **Migrations:** no schema change, no settings change, no plan-file change. The sidecar is a new additive file; its absence is the normal state and is handled.
- **Files touched:** `src/services/TaskViewerProvider.ts`, `src/services/TicketsPanelProvider.ts`, `src/standalone/bootstrap.ts`, `src/webview/tickets.js`, `src/test/verb-engine-tickets-headless.test.js`. (`src/services/headlessPanelHtml.ts` was dropped from this set when the CSP widening was cut.)

## Dependencies

- No external session dependencies (`sess_*`) — this plan is self-contained.
- **Sibling ordering within this feature:** land **after** `feature_plan_20260807161810_ticket-push-truncates-at-any-subtasks-heading.md`. Both edit `TaskViewerProvider.ts` (that plan at ~22067-22132, this one at ~23507-23680) — disjoint regions with no logical conflict, but the project PRD's orchestration discipline is *one agent stream per provider file*, so they serialise.
- Independent of `feature_plan_20260807161809_tickets-subtask-drilldown-sync-badge-always-local.md` in design. Both edit `src/webview/tickets.js` — this plan only inside `renderAttachmentsList` (~2774-2837), that plan only in the badge/request/response arms — so they merge cleanly in either order, but should not be edited by two concurrent streams.

## Adversarial Synthesis

**Risk Summary.** The headline risk is regression on shipped installs: the download destination moves, so a reader that trusts provenance too eagerly hides every pre-existing attachment, and one that trusts the legacy guess too long keeps serving the wrong ticket's file. The mitigation is the per-ticket-scoped precedence rule (record authoritative once any record exists for that ticket; legacy `existsSync` only when there is none). Secondary risks: the `webviewUri` change intentionally flips a green contract test that pins the opposite behaviour — retarget it deliberately or it will be "fixed" back; and the browser-cockpit half of the goal is unreachable without the standalone command bridge, so a CSP-only change would pass every gate while the cockpit modal still reports "No attachments found."

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — resolve the ticket's real directory (`downloadAttachment` ~23507, `getAttachmentList` ~23620)

Extract the shared derivation so both use the ticket's actual file location first, with the current hierarchy derivation kept only as a fallback for tickets with no local document.

```ts
    /**
     * Attachments directory for ONE ticket.
     *
     * Prefers the directory of the ticket's own imported document — the hierarchy
     * derivation below reads the picker's CURRENT selection (getSelectedHierarchy /
     * getTeamName), which drifts the moment the operator changes list, opens a
     * subtask drill-down, or the ticket was imported under a different list.
     */
    private async _ticketAttachmentsDir(
        resolvedRoot: string, provider: 'linear' | 'clickup', ticketId: string
    ): Promise<string> {
        const docPath = await this._findTicketDocument(resolvedRoot, provider, ticketId);
        if (docPath) { return path.join(path.dirname(docPath), 'attachments'); }
        // …existing segments + _buildTicketDir fallback, unchanged…
    }
```

`downloadAttachment` keeps its traversal guard, re-anchored on whichever base dir was chosen:

```ts
            const targetDir = await this._ticketAttachmentsDir(resolvedRoot, provider, ticketId);
            const resolvedTargetDir = path.resolve(targetDir);
            const resolvedBaseFolder = path.resolve(path.dirname(targetDir));
            if (!resolvedTargetDir.startsWith(resolvedBaseFolder + path.sep) && resolvedTargetDir !== resolvedBaseFolder) {
                return { success: false, error: 'Path traversal detected.' };
            }
```

Add a provenance sidecar written at download time and read at list time. Keyed by ticket id, so two tickets sharing a filename can never claim each other's file:

```ts
    /**
     * `<attachmentsDir>/_attachments.json` — { "<provider>_<ticketId>": { "<assetKey>": "<absolute path>" } }
     *
     * `assetKey` is the attachment's STABLE provider id, never its URL. ClickUp
     * pre-signs every attachment URL per fetch (`?X-Amz-Signature=…&X-Amz-Expires=…`,
     * 60-minute TTL) and Linear's signed URLs expire too, so a URL-keyed record misses
     * on the very next list fetch and the download is "forgotten" again.
     */
    private _readAttachmentIndex(dir: string): Record<string, Record<string, string>> {
        try { return JSON.parse(fs.readFileSync(path.join(dir, '_attachments.json'), 'utf8')); }
        catch { return {}; }
    }
    private _recordAttachment(dir: string, key: string, assetKey: string, filePath: string): void {
        const idx = this._readAttachmentIndex(dir);
        idx[key] = { ...(idx[key] || {}), [assetKey]: filePath };
        try { fs.writeFileSync(path.join(dir, '_attachments.json'), JSON.stringify(idx, null, 2), 'utf8'); }
        catch (e) { console.warn('[TaskViewerProvider] attachment index write failed:', e); }
    }

    /**
     * Stable key for one remote asset. Prefers the provider's attachment id; falls back
     * to the URL's origin+pathname with the query string dropped — that is where the
     * signature and expiry live, and everything before it is stable.
     */
    private _assetKey(attachmentId: string | undefined, url: string): string {
        if (attachmentId) { return attachmentId; }
        try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return url; }
    }
```

`downloadAttachment` calls `_recordAttachment(resolvedTargetDir, \`${provider}_${ticketId}\`, this._assetKey(attachmentId, url), targetFilePath)` immediately before `return { success: true, filePath: targetFilePath }` (line 23614). Its `data` parameter gains `attachmentId?: string` — see the `tickets.js` change below, which is what supplies it.

`getAttachmentList` stops guessing:

```ts
            const targetDir = await this._ticketAttachmentsDir(resolvedRoot, provider, ticketId);
            const key = `${provider}_${ticketId}`;
            const index = this._readAttachmentIndex(targetDir)[key] || {};
            const hasProvenance = Object.keys(index).length > 0;

            return attachmentsArray.map(attachment => {
                const url = attachment.url || '';
                let filename = /* …unchanged filename derivation, lines 23658-23667… */;

                // Authoritative: what THIS ticket actually downloaded, keyed by the
                // attachment's stable id — NOT its url, which is re-signed per fetch.
                let localPath = index[this._assetKey(attachment.id, url)] || '';
                // Legacy fallback ONLY for tickets with no provenance at all — pre-change
                // downloads landed in the shared flat folder with no record. Once a ticket
                // has any recorded download, the record is the only truth.
                if (!localPath && !hasProvenance) {
                    const guessed = path.join(targetDir, filename);
                    if (fs.existsSync(guessed)) { localPath = guessed; }
                }
                const isDownloaded = !!localPath && fs.existsSync(localPath);
                return { filename, url, localPath: isDownloaded ? localPath : '', isDownloaded };
            });
```

### `src/services/TicketsPanelProvider.ts` — one decoration that works on both hosts (`viewAttachments`, lines 2884-2896)

Replace the existing panel-only decoration. The image-extension gate and the "no webview ⇒ no rewrite" comment are shipped behaviour and must not be dropped wholesale — only the *URL source* changes, and the panel fallback stays for the case where no API server port is available.

```ts
                    // webviewUri prefers the loopback asset route: `_buildLocalAssetUrl`
                    // emits an allow-listed http://127.0.0.1:<port>/design/asset URL that
                    // satisfies BOTH hosts (tickets.html's meta CSP already permits
                    // http://127.0.0.1:*), so the browser cockpit can finally preview a
                    // downloaded image. asWebviewUri stays as the fallback for a VS Code
                    // panel with no API server running. Headless with no port and no panel
                    // still yields no webviewUri — the preview branch just stays off.
                    if (Array.isArray(result)) {
                        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
                        result = result.map((att: any) => {
                            if (!att.isDownloaded || !att.localPath) { return att; }
                            if (!imageExts.includes(path.extname(att.localPath).toLowerCase())) { return att; }
                            const uri = this._buildLocalAssetUrl(att.localPath)
                                || (targetPanel?.webview
                                    ? targetPanel.webview.asWebviewUri(vscode.Uri.file(att.localPath)).toString()
                                    : undefined);
                            if (uri) { att.webviewUri = uri; }
                            return att;
                        });
                    }
```

`_buildLocalAssetUrl` returning `undefined` (no port, or outside an allowed asset root) simply leaves `webviewUri` unset — no unguarded URL is ever emitted.

### `src/services/TicketsPanelProvider.ts` — cover the configured ticket save location (`getTicketsAssetRoots`, lines 443-453)

Without this, every install whose `ticketSaveLocation` sits outside `.switchboard/tickets` and outside the folder-config paths gets `undefined` from `_buildLocalAssetUrl` and silently loses the preview the rest of this plan builds.

```ts
        // The integration config's ticketSaveLocation is where _buildTicketDir actually
        // writes ticket documents (TaskViewerProvider.ts:21960-21971). It is a DIFFERENT
        // setting from LocalFolderService's ticketsFolderPaths, so a custom save location
        // was absent from the allow-list and every asset under it failed the guard.
        for (const p of ['linear', 'clickup'] as const) {
            try {
                const cfg = GlobalIntegrationConfigService.loadConfigSync(p);
                if (cfg?.ticketSaveLocation) { roots.push(path.join(cfg.ticketSaveLocation, p)); }
            } catch { /* config unreadable — the defaults below still apply */ }
        }
```

### `src/standalone/bootstrap.ts` — bridge the attachment commands (beside the existing registrations, ~line 812)

Layer 2 of PRD contract #7. Without these, `viewAttachments` in `npx switchboard` returns `success: true` with `attachments: undefined` and the modal reports "No attachments found" for every ticket.

```ts
    // Attachments. Registered ONLY in extension.ts today (lines 2096/2101), so the
    // standalone host's registry-first command seam fell through to vscodeShim's no-op
    // and viewAttachments returned success with no data — a faked success (contract #6)
    // and a missing Layer 2 (contract #7).
    switchboardCommandRegistry.register('switchboard.getAttachmentList', async (data: any) =>
        await taskViewerProvider.getAttachmentList(
            data.workspaceRoot || workspaceRoot, data.provider, data.ticketId, data.attachmentsArray
        ));
    switchboardCommandRegistry.register('switchboard.downloadAttachment', async (data: any) =>
        await taskViewerProvider.downloadAttachment(data.workspaceRoot || workspaceRoot, data));
```

Match the argument shape used by `extension.ts:2096-2105` exactly — both commands take a single object and the provider methods take `(workspaceRoot, …)` positionally.

### `src/webview/tickets.js` — do not imply a local file when there isn't one (`renderAttachmentsList`, lines 2774-2837)

The `isDownloaded` branches already gate `Open`/`Reveal` (2793-2797) and the `Path:` line (2809-2814), so they become correct automatically once `isDownloaded` stops lying. Add one honest affordance for the remote-only case, beside the existing Download button (line 2800):

```js
                            <a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="strip-btn" style="font-size: 11px; padding: 2px 6px;">Open remote</a>
```

A plain anchor, deliberately — the ticket cards already open external URLs this way rather than via `openExternalUrl`, to bypass the host permission modal (see the comment at `tickets.js:624-627` and the card markup at lines 628 / 663). This gives a remote attachment a remote action instead of only a local one, and it is now the *only* way to view a not-yet-downloaded provider attachment: it opens in the system browser, where the operator's own Linear/ClickUp session supplies the auth an `<img>` tag cannot.

### `src/webview/tickets.js` — pass the attachment id to the download path (`renderAttachmentsList` button markup ~2800, handler ~2862-2878)

The sidecar is keyed on the attachment's stable id, but the download button currently carries only `data-url` / `data-filename` and the `downloadAttachment` message sends no id. Add both:

```js
                            <button class="strip-btn download-attachment-modal-btn"
                                    data-url="${escapeAttr(url)}"
                                    data-filename="${escapeAttr(filename)}"
                                    data-attachment-id="${escapeAttr(att.id || '')}"
                                    style="…unchanged…">Download</button>
```

and in the click handler (~2870), add `attachmentId: btn.dataset.attachmentId || undefined` to the `postMessage` payload. The second download call site (`tickets.js:5245`) needs the same field. `getAttachmentList` must also pass `attachment.id` straight through in its returned rows so the modal has it to hand back.

> **Note on the schema:** `downloadAttachment` has **no entry in `verbSchemas.ts`**, so this new field needs no schema edit — but that absence is itself a gap against PRD contract #5 (validate every verb's payload at the HTTP boundary). Pre-existing and out of scope here; flagged so it is not mistaken for something this plan removed.

### `src/services/headlessPanelHtml.ts` — no change

> **Superseded:** a `getTicketsHtml` CSP edit widening `img-src` to `https:`.
> **Reason:** see root cause 3. Linear returns 401 to an unauthenticated `<img>` fetch and ClickUp's pre-signed URLs expire in 60 minutes, so the widening cannot render provider attachments; it only enlarges the cockpit's image-source surface. Cutting it also removes this plan's only security-posture change.
> **Replaced with:** nothing. `headlessPanelHtml.ts` is no longer in this plan's file set.

## Resolved Assumptions

Settled by web research on 2026-08-08 — **authoritative, do not re-open**:

- **Linear (`uploads.linear.app`)** requires `Authorization: Bearer <token>`; an unauthenticated GET returns **HTTP 401**. HTML `<img>` cannot send that header, so a plain `<img>` can never render a Linear attachment. Time-limited signed URLs exist but only via a `public-file-urls-expire-in: <seconds>` header on the GraphQL request, and they expire. `public.linear.app` serves genuinely public assets but workspace attachments do not land there.
- **ClickUp** now enforces "Private Attachment Links" on **all** plans: attachment URLs are S3/CloudFront pre-signed and **expire 60 minutes** after generation, returning HTTP 403 afterwards. The old never-expiring `attachments-public.clickup.com` public-by-obscurity URLs are legacy.
- **CORS is not the blocker for `<img>`.** A plain `<img>` is a simple cross-origin GET and is not CORS-gated; the failure is authentication (401) or expiry (403), which happens before CORS is relevant. CORS *would* block a `fetch()`-based workaround from the webview, so that is not an escape hatch either.
- **Industry pattern:** Slack, Zapier and Notion all download the binary server-side with stored credentials and re-host/proxy it. Download-then-serve-locally is the standard architecture for exactly this problem, and is what this plan implements via `_buildLocalAssetUrl`.

Consequence for this plan: the local loopback asset route is not merely the *better* option, it is the only one that works. Everything else here was answerable from the codebase and was verified against HEAD.

## Verification Plan

### Automated Tests
1. `npm run test:contract:verb-engine-tickets` — **`src/test/verb-engine-tickets-headless.test.js:397-407` must be retargeted, not merely re-run.** It currently asserts `result.attachments[0].webviewUri === undefined` under the comment *"Headless has no webview → webviewUri must NOT be set (host-agnostic guard)."* That is the behaviour being deliberately changed. Note the test would otherwise stay green **by accident** — its stub returns `localPath: '/tmp/a.png'`, a non-existent path outside every allowed asset root, so `_buildLocalAssetUrl` returns `undefined` regardless. Replace it with two explicit cases: (a) no API server port and no panel → `webviewUri === undefined`, still host-agnostic and still reaching no `vscode`; (b) a stub API server reporting a port plus a real temp file inside an allowed asset root → `webviewUri` is the `http://127.0.0.1:<port>/design/asset?…` URL. Case (b) is the assertion that proves the browser cockpit can preview.
2. `npm run test:contract:design-asset` — the asset-route traversal test guards `_buildLocalAssetUrl`'s allow-list; must stay green now that it is reached from a second caller and the allow-list has gained the `ticketSaveLocation` roots.
3. Add source assertions in a tickets contract test: `getAttachmentList` must not contain a bare `fs.existsSync(path.join(targetDir, filename))` as its only `isDownloaded` source; `bootstrap.ts` must register both `switchboard.getAttachmentList` and `switchboard.downloadAttachment`; and `_recordAttachment` must be called with `_assetKey(...)` rather than a raw `url`, so a later "simplify the key" pass cannot silently reintroduce URL-keyed provenance.
4. Unit-test `_assetKey`: a present attachment id wins; a missing id falls back to origin+pathname; two ClickUp URLs differing only in their `X-Amz-Signature` / `X-Amz-Expires` query parameters must produce the **same** key. That last case is the regression guard for the 60-minute re-signing behaviour.

### Manual (VSIX install)
4. **False positive, the reported bug.** In one ClickUp list, download `image.png` from ticket A. Open ticket B, which has a *different* attachment also named `image.png`. Expected: ticket B shows **Download** and **Open remote**, with no `Path:` line and no Open/Reveal. Before the fix it shows Open/Reveal pointing at ticket A's file.
5. **Correct positive.** Download ticket B's attachment. Expected: Open/Reveal appear, `Path:` shows a file inside ticket B's own ticket directory, and — for an image — the inline preview renders.
6. **Legacy install.** On a workspace with pre-existing downloads and no `_attachments.json`, confirm existing attachments still show Open/Reveal (the no-provenance fallback). Download one new attachment; confirm the sidecar appears and the ticket switches to record-driven resolution without losing the legacy entries it still has files for.
7. **Directory drift.** Open a ticket, then change the ClickUp list picker to a different list, then reopen the Attachments modal. Expected: the resolved directory still belongs to the ticket (verify via the `Path:` line), because it now comes from `_findTicketDocument`.
8. **Never-imported ticket.** Open the Attachments modal for a ticket that has no local document. Expected: no crash; the hierarchy fallback path is used and behaviour matches today's.
9. **Custom save location.** Point `ticketSaveLocation` at a directory outside the workspace, import a ticket, download an image attachment, and confirm the inline preview renders (this is the `getTicketsAssetRoots` widening).
10. **Browser cockpit — the modal.** Open the tickets panel on the standalone server and open the Attachments modal for a ticket that has attachments. Expected: rows appear. Before the bridge it reads "No attachments found" for every ticket.
11. **Browser cockpit — downloaded image previews.** Download an image attachment, then open the modal in the cockpit. Expected: the inline preview renders via the loopback asset route. Un-downloaded attachments show Download / Open remote and **no** inline preview — that is correct, not a bug: a provider URL cannot render in an `<img>`.
12. **Linear assets.** Confirm a Linear-hosted asset still downloads correctly through the token-attaching path, and that an un-downloaded Linear asset shows Download / Open remote rather than a broken inline image.
13. **Signed-URL stability — the key regression.** Download a ClickUp attachment. Wait for (or force) a list refetch so the attachment URL is re-signed, then reopen the modal. Expected: it still reads as downloaded, with Open/Reveal and the correct `Path:`. A URL-keyed sidecar fails exactly here, and only here — which is why it must be tested after a refetch, not immediately after the download.

## Recommendation

Complexity 7 → **Send to Lead Coder.**

## Review Findings

Reviewed as implemented. `_ticketAttachmentsDir` / `_readAttachmentIndex` / `_recordAttachment` / `_assetKey`, the `viewAttachments` dual-host decoration, the `getTicketsAssetRoots` widening, the standalone bridge and the `tickets.js` id plumbing all match the plan. Three defects fixed in `src/services/TaskViewerProvider.ts`: (1) **MAJOR** — `_recordAttachment` wrote without `mkdirSync`, so on any ticket with no `attachments/` directory the write threw ENOENT into its own `catch` and provenance silently vanished; (2) **MAJOR** — the sibling relocalisation subtask wrote inline-image records into the *same* ticket key, so one push of a locally-authored image set `hasProvenance` and disarmed the legacy `existsSync` fallback, hiding every pre-change download on the install base — inline uploads now live in a separate `#images` namespace that `_relocalizeInlineImages` merges but `getAttachmentList` ignores; (3) **MAJOR** — plan verification #1 was not done: `verb-engine-tickets-headless.test.js:397` still pinned "headless ⇒ no `webviewUri`" and passed only by accident (its stub path lies outside every allowed asset root), leaving the cockpit-preview capability untested — replaced with three cases including a real temp file plus a stubbed API port that asserts the `http://127.0.0.1:<port>/design/asset` URL. Files changed: `TaskViewerProvider.ts`, `src/extension.ts` (declare `attachmentId` on the command signature), `src/test/tickets-subtask-embedding.test.js`, `src/test/verb-engine-tickets-headless.test.js`. Validation: `test:contract:{tickets-subtasks,verb-engine-tickets,design-asset,tickets-sidebar-scoping}` green, `compile-tests` + webpack clean, all static gates green after regenerating `protocol-catalog.json`. Remaining risk: the manual matrix (legacy install, custom `ticketSaveLocation`, cockpit modal, re-signed-URL refetch) is still unrun — automated coverage is source-level plus the new headless asset-URL case.
