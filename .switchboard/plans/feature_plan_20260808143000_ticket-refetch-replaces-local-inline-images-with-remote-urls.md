# Refetching a ticket replaces its local inline image paths with remote URLs that don't render

## Goal

Make a ticket refetch preserve the operator's locally-stored inline images. When a ticket's description is re-imported from Linear/ClickUp and an image in it is one we uploaded from a local file — or one we have already downloaded — the local markdown must point back at that local file, so the image keeps rendering exactly as it did before the refetch. The remote keeps its hosted CDN URL; only the local `.md` is mapped back.

### Problem

Author a ticket locally with an inline image (`![shot](attachments/shot.png)`). It renders. Push it. Later refetch the ticket. Every inline image link in the local file has been replaced with a remote URL (`https://uploads.linear.app/…` / a ClickUp attachments CDN URL), and the images stop displaying — a broken-image box in the VS Code webview, nothing at all in the browser cockpit. The local image file is still sitting on disk, untouched, right next to the ticket.

Reported symptom, verbatim: *"after tickets got refetched, the inline markdown links changed from local to trying to link to remote sources, which obviously don't display. It always used to work like even if I refetched, the attachments would be stored locally and displayed as local files. If those files were the same as I uploaded, then hopefully it would just continue showing my original files."*

### Root cause (confirmed against the code)

This is **not an accidental regression**. It is the cost side of a deliberate design change, and the design's key assumption does not hold on either host.

**1. Push deliberately rewrites local image refs to hosted CDN URLs.**

`hostInlineImages` → `uploadInlineImagesAndRewrite` (`src/services/ImageHostingHelper.ts:31-99`) walks `![…](src)` matches, skips anything already `http(s):`/`data:`, resolves the rest to a local file, uploads the bytes to the provider, and rewrites the markdown to the returned URL. `pushTicketEdits` calls it for both providers (`TaskViewerProvider.ts:22092` Linear, `22102` ClickUp).

This was introduced on **2026-06-18** (`fddf151f`, which created `ImageHostingHelper.ts`) and refactored on **2026-06-19** (`8a7e20a3` *"ticket images fixes"*). That commit also added the design plan `.switchboard/plans/push-local-inline-images-as-attachments.md`, which states the intent plainly:

> *"…the markdown rewritten to the resulting hosted CDN URL — both in the pushed payload **and** in the local `.md` file. This makes locally-authored images render for everyone in ClickUp/Linear and in the webview's source/ClickUp/Linear tabs, instead of silently breaking."*

So "local paths become CDN URLs" is intended behaviour. It fixed a real bug: before it, an absolute local path was shipped verbatim to the provider and the image was broken for every other human looking at the ticket.

**2. The design's assumption — "a CDN URL renders in the webview" — is false on both hosts, and false for both providers.**

Web research on 2026-08-08 settled this (see Resolved Assumptions):

- **Linear:** `uploads.linear.app` returns **HTTP 401** to an unauthenticated GET. An HTML `<img>` cannot send `Authorization: Bearer`, so a Linear-hosted image can *never* render from a plain markdown image reference — on either host, regardless of CSP.
- **ClickUp:** "Private Attachment Links" is enforced on all plans. Attachment URLs are pre-signed and **expire after 60 minutes**, then return 403. So a CDN URL written into a local `.md` renders for at most an hour after the fetch that produced it, and is permanently dead thereafter.
- **Browser cockpit** additionally blocks all of it at the CSP layer: `getTicketsHtml` (`src/services/headlessPanelHtml.ts:427`) has no `https:` in `img-src`.

This makes the defect worse than "images look broken". The CDN URLs that import writes into the local file were **never going to be durable**, on any host. Relocalising to the file on disk is not a nicety — it is the only mechanism that produces a stable render. The sibling attachments subtask reached the same conclusion independently and consequently dropped its CSP widening.

**3. Only half the design shipped, which is why the break surfaces at refetch rather than at push.**

`pushTicketEdits` assigns the rewritten markdown to a local `descriptionToPush` (`TaskViewerProvider.ts:22097`, `22107`) and never writes it back to the `.md`. So immediately after a push, the local file still holds local paths and still renders. The file only changes on the next import.

**4. Import rebuilds the file wholesale from the remote, so the CDN URLs land locally.**

`_writeTaskDocument` (`TaskViewerProvider.ts:22366-22427`) builds `content` entirely from the remote payload via `_buildLinearImportPlanContent` / `_buildClickUpImportPlanContent`, preserves **only** the `## Subtasks` block from the existing file (lines 22399-22411), then `fs.writeFileSync(filePath, content, 'utf8')` (22427). `importTaskAsDocument` does the same at lines 21866 / 21892. The description body — every image link in it — is replaced by whatever the remote holds, which is now the CDN URL push put there.

**5. The display path cannot recover it.**

`_rewriteLocalImagePaths` (`TicketsPanelProvider.ts:476-489`) converts local refs to loopback asset URLs, but returns early on anything matching `^(https?:|data:|vscode-resource:|vscode-webview-resource:|vscode-webview:)` (line 479). A CDN URL is passed through untouched by design — it has no way to know that URL corresponds to a file on disk.

**6. The mapping needed to fix this already exists and is thrown away.**

`uploadInlineImagesAndRewrite` builds `replacements: Array<{ from: string; to: string }>` — the exact local-path → CDN-URL pairs — and returns it (`ImageHostingHelper.ts:38, 67, 84`). `hostInlineImages` then drops it, returning only `{ rewritten, warnings }` (lines 87-99). **`replacements` has zero consumers anywhere in the codebase.** Every one of the four call sites (`TaskViewerProvider.ts:22092`, `22102`; `LinearSyncService.ts:2358`, `2449`; `ClickUpSyncService.ts:1486`, `3005`) discards it. Persist that map and import can reverse the rewrite.

## Metadata

- **Complexity:** 6
- **Tags:** backend, bugfix, reliability, ui
- **Project:** Browser Switchboard
- **Feature:** d4e35f49-14b0-44af-acd3-e971d660c674

## User Review Required

None. The three calls are made: (a) do **not** revert the CDN rewrite — that reintroduces the 2026-06-18 bug where images broke for every other person reading the ticket; the remote keeps hosted URLs. (b) The reverse map is persisted in the same per-directory `_attachments.json` sidecar the attachments subtask introduces, not a DB table — no schema migration on a published extension. (c) The rewrite-back is applied at import time to the file body only; the in-memory display path is left alone, so one mechanism owns the behaviour.

## Complexity Audit

### Routine
- The forward mapping is already computed and already returned — `replacements` at `ImageHostingHelper.ts:84`. Plumbing it out of `hostInlineImages` is a one-line signature widening plus four call-site updates.
- The sidecar read/write helpers (`_readAttachmentIndex` / `_recordAttachment`) and their `{ "<provider>_<ticketId>": { "<url>": "<abs path>" } }` shape are specified by the sibling attachments subtask and are directly reusable — that shape is already "given a remote URL, which local file is it?", which is exactly this lookup.
- The reverse rewrite is a single regex pass over `content` immediately before the two `writeFileSync` calls.

### Complex / Risky
- **Two import write sites, not one.** `_writeTaskDocument` (22366-22427, bulk/refetch) and `importTaskAsDocument` (21866/21892, single import). Fixing only the one you happen to test leaves the other silently broken, and the reported symptom appears on refetch — the bulk path.
- **Bidirectional truth.** The sidecar must hold both directions of provenance: attachments *downloaded from* the remote (the attachments subtask's writer) and local images *uploaded to* the remote (this plan's writer). Both answer the same question, so they share one map — but two writers on one file means the record format must be additive and neither writer may clobber the other's keys.
- **Absolute vs. relative paths in the rewritten markdown.** Writing an absolute path back into the `.md` makes the file non-portable across machines and clones. A path relative to the ticket file's directory is portable and is what `resolveLocalImagePath` already expects (`ImageHostingHelper.ts:24-28`). Choose relative; compute it against the ticket file's final directory, which is known at write time.
- **The file moves.** `_writeTaskDocument` slugifies the filename from the *current* title (22424-22426) and `_removeOrphanTicketFiles` cleans up the old one (22429). A renamed ticket lands in a new filename — and, if the list changed, a new directory. A relative image path computed against the old location breaks. Recompute against the path actually being written.
- **Stale/missing local file.** A recorded local source image can be deleted or moved by the operator. Rewriting to a path that no longer exists produces a broken local image where a possibly-working remote URL stood. The rewrite must `existsSync`-check before substituting and leave the CDN URL in place otherwise.
- **Install base.** ~4,000 installs already have ticket `.md` files full of CDN URLs from the last two months, with no sidecar record — nothing maps them back. Those files stay as they are; the fix is forward-only. Say so rather than implying a repair.

## Edge-Case & Dependency Audit

### Race Conditions
- **Push then immediate refetch.** The sidecar write must complete inside `pushTicketEdits` before it returns, so a refetch triggered by the post-push `registerImportedTicket` touch (22121-22127) already sees the mapping. Write the record before the provider update returns control, not in a fire-and-forget.
- **Two writers on one sidecar.** The attachments subtask writes download records; this plan writes upload records. Both do read-modify-write on `_attachments.json`. Same accepted trade-off as that plan: a lost update degrades to "one image stays a CDN URL", never to a wrong file, because every resolved path is `existsSync`-checked before use.

### Security
- **Path containment.** A sidecar value is used to rewrite a markdown link that the webview will later resolve. `_rewriteLocalImagePaths` resolves relative refs against the ticket's own directory and `_buildLocalAssetUrl` re-validates the realpath against the allow-listed asset roots (`TicketsPanelProvider.ts:459-471`), so a hand-edited sidecar cannot escape the guard — but this plan must not introduce a path that bypasses those two. Emit only relative paths under the ticket directory; if the recorded source lies outside it, leave the CDN URL alone rather than emitting `../../…`.
- No new network calls, no new credentials, no change to what is uploaded.

### Side Effects
- **Local `.md` content changes on import** for tickets with mapped images — link targets only, never surrounding text. This is the fix, but it means a git-tracked ticket file shows a diff after a refetch.
- **Remote is unchanged.** The provider description keeps its CDN URLs, so other people reading the ticket in Linear/ClickUp see the images exactly as they do today. That is the property the 2026-06-18 change bought and this plan must not spend.
- **Round-trip stability.** After the rewrite-back, the local file holds a local path again. The next push re-uploads it and re-rewrites to a CDN URL — a duplicate upload per push cycle. Mitigate by keying the sidecar on the local path too, so `uploadInlineImagesAndRewrite` can skip re-uploading a file whose hosted URL is already recorded and unchanged. Without this the ticket accumulates a new attachment on the remote on every push.

### Dependencies & Conflicts
- **Legacy files:** ticket `.md`s already rewritten to CDN URLs before this change have no sidecar record and stay as-is. No migration, no repair pass — stated, not hidden.
- **Images that were never local:** an image genuinely attached in ClickUp/Linear by someone else arrives as a CDN URL with no record. Untouched, renders remotely (subject to the CSP/auth question below). Correct behaviour.
- **Data URIs and non-file schemes:** already skipped by `uploadInlineImagesAndRewrite` (lines 45-50); the reverse pass must skip them identically.
- **Duplicate images:** the same local file referenced twice in one description uploads once (`uploadedByRaw`, line 39) and both refs rewrite; the reverse pass must handle multiple occurrences of one URL — use a global replace, as the forward pass does (line 79-82).
- **CRLF / markdown variants:** the forward regex is `/!\[[^\]]*\]\(([^)]+)\)/g`. Reuse the identical pattern for the reverse pass so the two cannot disagree about what an image reference is. Note it does not handle reference-style links (`![a][ref]`) or angle-bracketed targets — neither does the forward pass, so behaviour is symmetric; do not widen one side only.
- **Migrations:** none. The sidecar is additive on disk and its absence is the normal state.
- **Files touched:** `src/services/ImageHostingHelper.ts`, `src/services/TaskViewerProvider.ts` (`pushTicketEdits`, `importTaskAsDocument`, `_writeTaskDocument`), `src/services/LinearSyncService.ts` and `src/services/ClickUpSyncService.ts` (call-site signature updates only).

## Dependencies

- No external session dependencies (`sess_*`).
- **Depends on `feature_plan_20260807161808_tickets-remote-attachments-presented-as-local-files.md`** for the `_attachments.json` sidecar and its `_readAttachmentIndex` / `_recordAttachment` helpers. Land that subtask first and reuse them. If this plan ships first, it must introduce those helpers itself and the attachments subtask then reuses them — one owner either way, never two implementations of the same file format.
- Shares `src/services/TaskViewerProvider.ts` with the attachments subtask (~23507-23680) and the push-truncation subtask (~22067-22132). This plan touches ~21866, ~22092-22107, and ~22366-22427. Disjoint regions, but per the project PRD's orchestration discipline — one agent stream per provider file — all three serialise.

## Adversarial Synthesis

**Risk Summary.** The trap is over-correcting: reverting the CDN rewrite would fix the local render and re-break the ticket for everyone reading it in Linear/ClickUp, which is the bug the 2026-06-18 change existed to fix. The design here keeps remote hosting and only maps the *local* file back, so both properties hold. Residual risks are the rewrite pointing at a moved/deleted source (guarded by an `existsSync` check that falls back to the CDN URL), a non-portable absolute path leaking into a git-tracked `.md` (guarded by emitting only ticket-relative paths and declining anything outside the ticket directory), and an upload-per-push loop that grows remote attachments (guarded by keying the sidecar so an unchanged file is not re-uploaded).

## Proposed Changes

### `src/services/ImageHostingHelper.ts` — stop discarding the mapping (`hostInlineImages`, lines 87-99)

```ts
export async function hostInlineImages(
    upload: (fileName: string, buffer: Buffer) => Promise<{ url: string }>,
    description: string,
    sourceFilePath?: string
): Promise<{ rewritten: string; replacements: Array<{ from: string; to: string }>; warnings: string[] }> {
    // `replacements` (local src -> hosted URL) is the ONLY record of which CDN URL came
    // from which local file. It was computed and then dropped here, with zero consumers
    // anywhere in the codebase — which is why a refetch could not map a CDN URL back to
    // the operator's own image and silently replaced it.
    const { rewritten, replacements, warnings } = await uploadInlineImagesAndRewrite(
        description, sourceFilePath, upload
    );
    return { rewritten, replacements, warnings };
}
```

The four existing call sites destructure only `{ rewritten }` / `{ rewritten, warnings }`, so widening the return type is source-compatible — `LinearSyncService.ts:2358`, `2449` and `ClickUpSyncService.ts:1486`, `3005` need no edit beyond an optional follow-up to record their own mappings (out of scope here; those are plan→ticket *creation* paths, not the refetch loop).

### `src/services/TaskViewerProvider.ts` — record the mapping on push (`pushTicketEdits`, ~22092-22107)

For both providers, capture `replacements` and write each pair into the ticket's attachments sidecar, keyed by the hosted URL so import can look up by exactly what it finds in the remote body:

```ts
                const res = await hostInlineImages(/* …unchanged… */);
                descriptionToPush = res.rewritten;
                warningsAll.push(...res.warnings);
                // Persist local-source provenance for the inline images we just hosted.
                // Keyed by the hosted URL because that is what the next import will see
                // in the remote description; the value is the local file it came from.
                const dir = await this._ticketAttachmentsDir(resolvedRoot, provider, id);
                for (const r of res.replacements) {
                    const abs = resolveLocalImagePath(r.from, filePath);
                    // Key on the signature-stripped URL — the hosted URL we get back now
                    // is not the string the next import will see. `_assetKey(undefined, …)`
                    // reduces both to origin+pathname.
                    if (abs) { this._recordAttachment(dir, `${provider}_${id}`, this._assetKey(undefined, r.to), abs); }
                }
```

`_ticketAttachmentsDir`, `_recordAttachment`, `_assetKey` and `resolveLocalImagePath` all already exist (the first three from the attachments subtask; the last is exported at `ImageHostingHelper.ts:9`).

### `src/services/TaskViewerProvider.ts` — map hosted URLs back to local files on import

Add one helper and call it at **both** write sites.

```ts
    /**
     * Rewrite inline image refs in an imported body back to the local files they were
     * uploaded from.
     *
     * Import rebuilds the ticket .md wholesale from the remote payload, so every image
     * link becomes whatever the remote holds — and push deliberately rewrites local refs
     * to hosted CDN URLs. The net effect was that a refetch replaced the operator's own
     * rendering images with remote URLs that are blocked (browser cockpit CSP) or
     * auth-gated (Linear assets). The remote keeps its hosted URL; only the local copy is
     * mapped back, so other people reading the ticket are unaffected.
     *
     * Emits a path RELATIVE to the file being written — absolute paths are not portable
     * across machines or clones, and the ticket filename is slugified from the current
     * title, so the target directory is only known here.
     */
    private _relocalizeInlineImages(content: string, dir: string, key: string, targetFilePath: string): string {
        const index = this._readAttachmentIndex(dir)[key] || {};
        if (Object.keys(index).length === 0) { return content; }
        return content.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (match, rawSrc) => {
            // Look up by the STABLE asset key, not the raw URL. Both providers re-sign
            // asset URLs (ClickUp pre-signed with a 60-minute TTL; Linear signed on
            // request), so the query string differs between the push that recorded the
            // mapping and the import that reads it. `_assetKey` drops the query.
            const abs = index[this._assetKey(undefined, String(rawSrc).trim())];
            if (!abs || !fs.existsSync(abs)) { return match; }      // moved/deleted → keep the CDN URL
            const rel = path.relative(path.dirname(targetFilePath), abs);
            if (rel.startsWith('..') || path.isAbsolute(rel)) { return match; }  // outside the ticket dir → keep
            return match.replace(rawSrc, rel.split(path.sep).join('/'));
        });
    }
```

Call it immediately before each `writeFileSync`, once the final path is known:

- `_writeTaskDocument` — after `const filePath = path.join(targetDir, filename);` (line 22426), before the write:
  ```ts
            content = this._relocalizeInlineImages(content, path.join(targetDir, 'attachments'), `${provider}_${id}`, filePath);
            fs.writeFileSync(filePath, content, 'utf8');
  ```
- `importTaskAsDocument` — the same call against that method's resolved target path, after its own `content` assembly (~21866 / 21892) and before its write.

Using `path.join(targetDir, 'attachments')` rather than `_ticketAttachmentsDir` here is deliberate: the file is being written to `targetDir` *now*, so its sidecar is the one beside it — `_ticketAttachmentsDir` resolves through `_findTicketDocument`, which still points at the pre-write location.

### `src/services/ImageHostingHelper.ts` — do not re-upload an unchanged file (`uploadInlineImagesAndRewrite`, ~line 56)

Without this, every push after a rewrite-back re-uploads the same image and the remote accumulates a duplicate attachment per push cycle. Accept an optional "already hosted" lookup and skip:

```ts
        // Already hosted from this exact local file and still unchanged? Reuse the URL
        // rather than uploading a duplicate. The rewrite-back means the markdown holds a
        // local path again on every import, so without this each push adds an attachment.
        const known = alreadyHosted?.(localPath);
        if (known) { uploadedByRaw.set(rawSrc, known); replacements.push({ from: rawSrc, to: known }); continue; }
```

Populate `alreadyHosted` from the sidecar's inverted map at the `pushTicketEdits` call site. If the file's mtime is newer than the recorded upload, treat it as changed and re-upload.

## Resolved Assumptions

Settled by web research on 2026-08-08 — **authoritative, do not re-open, do not commission further research on this**:

- **Linear (`uploads.linear.app`)** requires `Authorization: Bearer <token>`; unauthenticated GET returns **HTTP 401**. HTML `<img>` cannot send that header. Signed URLs exist only via a `public-file-urls-expire-in: <seconds>` header on the GraphQL request and they expire.
- **ClickUp** enforces "Private Attachment Links" on all plans: attachment URLs are S3/CloudFront pre-signed and **expire 60 minutes** after generation, then 403. The old never-expiring `attachments-public.clickup.com` URLs are legacy.
- **CORS is not the blocker.** A plain `<img>` is a simple cross-origin GET and is not CORS-gated; the failure is 401/403, which precedes CORS. A `fetch()`-with-token workaround inside the webview *would* be CORS-blocked, so that is not an escape hatch either.
- **Industry pattern:** Slack, Zapier and Notion all download the binary server-side with stored credentials and re-host it. Download-then-serve-locally is the standard architecture for these two providers.

**Two consequences for this plan, both strengthening it:**

1. The "keep the CDN URL" fallback branches in `_relocalizeInlineImages` are a *degraded* path, not an equivalent one — a kept CDN URL will not render. They are still correct (better a dead link than a wrong local path), but the plan should not be read as offering two working outcomes.
2. Signed URLs are re-generated per fetch, so the sidecar must be keyed on the signature-stripped URL. Keying on the raw hosted URL means the mapping never matches at import time and the entire fix silently no-ops. This is now handled by `_assetKey`.

## Verification Plan

### Automated Tests
1. Unit-test `_relocalizeInlineImages` directly (pure apart from `existsSync`): a body with a mapped URL rewrites to a relative path; an unmapped URL is untouched; a mapped URL whose file no longer exists is untouched; a mapped file outside the ticket directory is untouched; a URL appearing twice rewrites both occurrences; `data:` and non-file schemes are untouched.
1b. **Re-signed URL case — the one that decides whether this fix works at all.** Record a mapping against `https://attachments-public.clickup.com/abc/x.png?X-Amz-Signature=AAA&X-Amz-Expires=3600`, then relocalise a body containing the same asset with `?X-Amz-Signature=BBB&X-Amz-Expires=3600`. It must rewrite. Keyed on the raw URL it does not, and the whole plan silently no-ops in production while every other test stays green.
2. Source assertion: `hostInlineImages` must return `replacements`, and `pushTicketEdits` must reference it — `replacements` having zero consumers is precisely the defect, so a test should keep it wired.
3. Source assertion: both `_writeTaskDocument` and `importTaskAsDocument` must call `_relocalizeInlineImages` before their `writeFileSync`. Fixing one path only is the most likely partial implementation.
4. `npm run test:contract:tickets-subtasks` — `_writeTaskDocument`'s merge rule is heavily pinned by this file; the new call must not disturb the `## Subtasks` preservation assertions.
5. `npm run test:contract:verb-engine-tickets` — the push arm must stay green with the widened `hostInlineImages` signature.

### Manual (VSIX install)
6. **The reported bug.** Author a ticket locally with `![shot](attachments/shot.png)` and confirm it renders. Push. Refetch the ticket. Expected: the local `.md` still references `attachments/shot.png` and the image still renders. Before the fix, the link is a CDN URL and the image is broken.
7. **Remote unaffected.** After step 6, open the same ticket in ClickUp/Linear in a browser. The image must still display there — the remote description keeps its hosted URL.
8. **No duplicate uploads.** Push → refetch → push again, three times. The remote ticket must accumulate exactly one attachment for that image, not three.
9. **Moved source file.** After step 6, move `shot.png` out of the attachments directory and refetch. Expected: the link stays a CDN URL (no broken relative path written) and nothing throws.
10. **Third-party image.** Open a ticket where someone else attached an image in ClickUp. Refetch. Expected: untouched — it has no sidecar record and must keep its remote URL. Note it will not render (401/403 per the research); that is out of this plan's scope and is what the attachments modal's Download button is for.
10b. **Delayed refetch (ClickUp expiry).** After step 6, wait more than 60 minutes, then refetch. Expected: the image still renders locally. This is the case where the old behaviour is unambiguously dead — the CDN URL written by a previous import has expired — so a pass here proves the relocalisation is doing the work rather than the remote URL happening to still resolve.
11. **Renamed ticket.** Rename the ticket remotely so the slugified filename changes, then refetch. Expected: the rewritten relative path is correct against the *new* filename's directory, and the image renders.
12. **Legacy file.** Take a ticket `.md` already full of CDN URLs from before this change and refetch. Expected: unchanged — forward-only, no repair pass, no crash.
13. **Browser cockpit.** Repeat step 6 against the standalone server; the relocalised image must render through the loopback asset route.

## Recommendation

Complexity 6 → **Send to Coder.**
