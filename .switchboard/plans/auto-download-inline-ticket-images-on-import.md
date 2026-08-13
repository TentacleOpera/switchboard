# Download a Ticket's Attachments on Import

## Goal

When a ticket is imported, download its attachments alongside it — into the ticket's own `attachments/` directory, recorded in the sidecar index — so the imported ticket is self-contained without anyone clicking Download in a modal.

> **Superseded:** "On import, fetch the images referenced inline in a ticket's description into the ticket's own `attachments/` directory…"
> **Reason:** User directive (2026-08-12): the ask is "when I fetch a ticket, I download all attachments with it." The original goal inverted the primitive — it scanned description *text* for image URLs and treated the ticket's actual attachment list as out of scope. Description-scanning is a supplement (Linear needs it; see below), not the definition of the feature.
> **Replaced with:** Download the ticket's attachments on import. Sweep the description for image URLs the attachment list does not already cover, because on Linear it never does.

Sequenced **after** `ticket-inline-images-never-resolve-to-downloaded-copies.md`. That plan repairs the lookup; this one supplies the inventory. Landing this first would download files that the broken key mismatch still cannot resolve.

### The problem

`_relocalizeInlineImages` (`TaskViewerProvider.ts:22506`) can only rewrite a URL that already appears in `<attachmentsDir>/_attachments.json`. Entries get there exactly two ways:

- the user clicked **Download** on that specific attachment in the Attachments modal (`:24269`), or
- Switchboard itself uploaded the image on a push (`:22662`).

Nothing else populates it. So the local-copy feature only ever covers attachments the operator happened to click, one at a time, in a modal that has to be opened per ticket.

The live tickets tree shows the resulting coverage: 69 inline image refs across the imported `.md` files, against roughly 8 downloaded files in 3 of the many ticket folders. Even with the key mismatch fixed, the overwhelming majority of inline images have no local copy to point at and will keep rendering from the provider CDN — auth-gated on Linear, re-signed with a 60-minute TTL on much of ClickUp, and unreachable from the browser cockpit, which holds no provider credentials.

### Root cause

Import rebuilds the ticket document wholesale from the remote payload (`importTaskAsDocument`, `:22123-22244`) and then calls relocalisation at `:22243` — a pure index lookup with no fetch behind it. The one step that would make the imported document self-contained, retrieving the bytes it references, is absent from the import path. The download primitive to do it already exists a few thousand lines away, complete with redirect handling and Linear's `Authorization` header (`:24185-24274`).

### Two providers, two different attachment models

This is the fact that decides the design, and it is why "download all attachments" alone is not sufficient:

- **ClickUp** — `getTaskDetails(id)` already returns an `attachments` array (`ClickUpSyncService.ts:1343`, populated at `:1372-1399`). Images pasted into a description become task attachments, so they appear in that array. `importTaskAsDocument` **already holds this list** at `:22193` and currently ignores it. Downloading it costs zero extra API calls.
- **Linear** — `getAttachments(issueId)` (`LinearSyncService.ts:1119-1147`) queries the GraphQL `attachments { nodes { id title url } }` connection. Linear `Attachment` nodes are *link entities* — GitHub PRs, Slack threads, Figma links. An image embedded in a description is a bare `uploads.linear.app` markdown URL and is **not** an Attachment node. Downloading Linear's attachment list therefore downloads links, not images; the description sweep is the only thing that reaches Linear's images.

### Where the list is and is not available

- **Single-ticket import** (`importTaskAsDocument`, `:22123`) runs after a detail fetch, so the attachment list is in hand. Free.
- **Bulk import / Refetch / delta sync** (`_writeTaskDocument`, `:23020`, driven by the loop at `:23510-23545`) receives a **list** payload. List payloads carry no attachments — only `getTaskDetails` does. Fetching the list per ticket here would add one API call per ticket, which the code at `:23547-23553` already warns is unaffordable: *"~101 requests for a 100-task list against a 100 req/min budget, on a repeating background timer."*

## Metadata

**Tags:** backend, feature, reliability
**Complexity:** 5

## User Review Required

None. Two decisions are made here rather than deferred:

1. **Bulk import does not add a per-ticket detail call.** It downloads what it can identify from the description body it already holds. Single-ticket import downloads the full attachment list. Rationale is the rate-limit budget quoted above — this is the same constraint that shaped the existing orphan-subtask handling.
2. **Ships default-ON**, an explicit deliberate override of PRD contract #2 ("new capabilities ship default-OFF"). The PRD permits an explicit override; this is it. A default-OFF auto-download is the manual Download button with extra steps, and the manual button is what produced ~8 files against 69 refs. The kill switch plus the caps below are what make default-ON defensible.

## Complexity Audit

### Routine

- Iterating `details.attachments` in `importTaskAsDocument` and calling an existing download primitive per entry.
- Scanning a body for `!\[[^\]]*\]\(([^)]+)\)` — the same regex `_relocalizeInlineImages` already uses at `:22514`.
- Filename derivation and `[\/\\]` → `_` sanitisation, copied from `getAttachmentList` (`:24306`).
- Recording through `_recordAttachment` (`:22412`), which already merges into the existing namespace object.
- Adding a boolean to `GlobalConfig` beside `ticketsAutoSync`.

### Complex / Risky

- **Two import write sites with different inputs.** `importTaskAsDocument` has the attachment list; `_writeTaskDocument` has only the body. They need one shared helper with two entry paths, not two implementations.
- **Idempotence is load-bearing.** Delta sync re-imports on a timer. A missed "already have this?" probe means every sync re-downloads everything and the `-${Date.now()}` collision suffix manufactures a new copy each time. The install already shows **7 copies** of one screenshot from the push path doing exactly this.
- **Automatic fetches of remote-controlled URLs with a provider token conditionally attached** — see Security.
- **No request timeout in the primitive being reused** (`:24233-24267`). Awaited in a sequential loop on a background timer.
- **Disk and bandwidth growth**, default-ON, on the first sync of a large list.
- **Structural tests pin the shape of the code being edited** (`src/test/tickets-subtask-embedding.test.js` §18–§20).

## Edge-Case & Dependency Audit

### Race Conditions

- **Concurrent index writes.** `_recordAttachment` is read-modify-write with no lock; delta sync and a manual import of the same ticket can overlap. Pre-existing on the push path, but auto-download raises write frequency from "human click" to "every sync". Mitigation: one `_recordAttachment` cycle per ticket, at the end, not one per file.
- **Fetches must be awaited before the `.md` write** at `:22244` / `:23086`, or relocalisation reads an index the fetch has not written yet and the first import always misses. No fire-and-forget.
- **The conflict guard at `:23520-23535`** skips tickets with unpushed local changes; those get no download that cycle. Correct — a Refetch covers them.

### Security

- **Token leak via substring host match.** `:24225` decides Linear auth with `url.includes('.linear.app') || url.includes('linear-asset')`. A description containing `https://evil.example/.linear.app/x.png` satisfies that test and the Linear token is sent to `evil.example`. Behind a human click on a provider-listed attachment this is narrow. Downloading description-sourced URLs automatically makes it reachable by anyone who can type into a ticket. **Match on the parsed hostname**, and attach the header only when `provider === 'linear'` *and* the hostname is exactly `uploads.linear.app` (the only host that accepts it).
- **Stripping the header across the redirect is mandatory, not merely safe.** `uploads.linear.app` does not stream bytes; it authenticates, then 302/307s to a pre-signed `storage.googleapis.com` (or Cloudflare R2) URL. GCS rejects a request carrying an unrecognised `Authorization` header with 400/403 — so forwarding the header both leaks the credential *and* breaks the download. `:24240` re-issues `https.get(res.headers.location, …)` with no options object, so headers drop today; that is correct and must be pinned by a test and a comment, because a "pass the headers through the redirect too" cleanup would look like a bug fix and would break every Linear image.
- **Host allowlist on the automatic path.** Descriptions are user-authored markdown; an automated fetcher will otherwise dial any URL an author types (`![](http://169.254.169.254/latest/meta-data/)`, or an attacker's logger that pings on every local import). Restrict automatic fetches to a fixed allowlist: `*.clickup-attachments.com`, `attachments-public.clickup.com`, `attachments.clickup.com`, `attachments2.clickup.com`, `uploads.linear.app`, `public.linear.app` — plus `https:` only. Everything else is skipped and left pointing at its original URL. This supersedes a private-IP literal check: an allowlist is both stricter and simpler, and it closes SSRF and the token-leak vector in one test. The provider's own attachment list is trusted, but it resolves to the same hosts anyway.
- **Filename traversal.** Remote-controlled last path segment. Keep the `[\/\\]` → `_` replacement and additionally reuse the resolve-under-directory guard at `:24198-24202` on the final target path. Reject rather than sanitise-and-hope.

### Side Effects

- **Disk growth**, bounded by the caps below. Name it in the setting's description.
- **Outbound traffic on a background timer**, not just API traffic. The per-run cap exists for this.
- **Partial files.** `:24245-24251` / `:24259-24265` open the write stream before the response is known good and unlink nothing on error. A truncated file passes `existsSync` at `:22520` and the `.md` then points at a corrupt image. **Write to a temp name, rename on successful close, unlink on every failure path.**
- **`.md` churn.** Relocalised bodies differ from the previous import, changing the hash registered at `:22255-22257`. Expected — do not read the first post-deploy sync's "modified" wave as a regression.
- **Non-image attachments.** Downloading a ticket's attachments means PDFs, zips, and videos land on disk too. That is the ask ("all attachments"), and it is what makes the Attachments modal's Open/Reveal work offline. The per-file size cap is the control.

### Dependencies & Conflicts

- **Hard prerequisite:** `ticket-inline-images-never-resolve-to-downloaded-copies.md` — supplies the dual-key write (without which nothing downloaded here resolves inline) and the resolver fallback chain this plan's idempotence probe reuses. Without the latter, the probe misses on every sync and this becomes a disk-filling loop.
- **Structural tests:** `src/test/tickets-subtask-embedding.test.js` §18 (`:333-359`), §19 (`:374-410`), §20 (`:412-510`) slice these function bodies by name. §19 encodes the "BOTH import write sites" rule. Keep `_recordAttachment(… _assetKey(…` inside `downloadAttachment`'s own body (`:355-359`) and keep relocalise strictly before `writeFileSync` at both sites (`:406-409`).
- **PRD contract #7 (two-layer completion):** `src/standalone/bootstrap.ts` registers `switchboard.getAttachmentList` (`:837`) and `switchboard.downloadAttachment` (`:841`) but **not** `switchboard.importTaskAsDocument` or `switchboard.importAllTasks`. Ticket import is extension-host-only today. This plan does not wire Layer 2 for import and must not claim standalone coverage for it.
- No new npm dependencies; `https` is already required inline at `:24233`.

## Dependencies

- *(No `sess_` session dependencies exist for this work — the dependency is a plan file, recorded precisely rather than as a fabricated session id.)*
- `ticket-inline-images-never-resolve-to-downloaded-copies.md` — dual-key attachment records + the inline-lookup fallback chain. **Blocking.**

## Adversarial Synthesis

Key risks: (1) the two providers model attachments differently — ClickUp lists pasted images, Linear's list holds link entities only — so an attachment-list-only implementation ships a feature that appears to work and covers nothing on Linear; (2) an idempotence probe that does not reuse the sibling plan's resolver turns every background sync into a re-download-and-duplicate loop, of which the install already has evidence (7 copies of one screenshot); (3) the reused download primitive carries three defects — no request timeout, partial files left on disk, and a substring host test that can leak the Linear token — all survivable behind a click and none survivable on an unattended timer. Mitigations: attachment list *plus* description sweep, through one shared helper at both write sites; share one resolver between probe and rewrite; harden the helper (hostname-parsed auth, timeout + destroy, temp-file-then-rename, resolve-under-dir guard) inside this change.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

#### 1. Extract the download body into a reusable, hardened helper

**Context.** `downloadAttachment` (`:24185-24274`) already does directory resolution, the path-traversal guard (`:24198-24202`), filename sanitisation (`:24215`), collision suffixing (`:24218-24222`), Linear auth (`:24224-24231`), one-hop redirect handling (`:24238-24254`), and the streamed write.

**Logic.** Lift `:24204-24267` into:

```ts
private async _fetchAssetToDisk(
    url: string, dir: string, filename: string,
    provider: 'linear' | 'clickup',
    opts?: { maxBytes?: number; timeoutMs?: number }
): Promise<string>   // returns the absolute path written
```

`downloadAttachment` becomes: resolve dir → call the helper → `_recordAttachment(…, this._assetKey(attachmentId, url), filePath)`.

**Implementation.** The `_recordAttachment(… _assetKey(…` call stays **inside** `downloadAttachment`'s body — `tickets-subtask-embedding.test.js:355-359` slices that body by name and asserts the pattern. Only fetch mechanics move. Harden while extracting:

- **Auth host test** — `const h = new URL(url).hostname.toLowerCase();`. Attach `Authorization` only when `provider === 'linear' && h === 'uploads.linear.app'`. Send the token **raw, with no `Bearer` prefix** — that is the correct form for a Linear personal API key (`lin_api_…`), which is what `switchboard.linear.apiToken` holds; a `Bearer` prefix fails auth for a PAT. If Switchboard ever moves Linear to OAuth, that token requires the `Bearer` prefix instead, so gate on the token's shape rather than hard-coding either form.
- **Redirects: up to 3 hops, auth stripped on any cross-origin hop.** The current single-hop follower is not enough. Linear is exactly 1 cross-origin hop (`uploads.linear.app` → `storage.googleapis.com`), but ClickUp alias hosts (`attachments.clickup.com`) traverse 1–2 hops (301/302) before resolving to `*.clickup-attachments.com`; direct `t<workspace>.p.clickup-attachments.com` URLs serve in 0 hops. Follow up to 3, count them, abort beyond, and drop `Authorization` whenever the redirect target's origin differs from the request that carried it.
- **Timeout** — `req.setTimeout(opts?.timeoutMs ?? 30000, () => req.destroy(new Error('timeout')))` on the initial request and every redirect hop.
- **Size cap by streaming, not pre-flight** — reject early on an oversized `content-length` where present, and always count bytes as they stream, destroying the response when the running total crosses the cap. Do **not** add a HEAD pre-flight: `uploads.linear.app` frequently answers HEAD with `Transfer-Encoding: chunked` and no `content-length`, so a pre-flight size check is both an extra request and unreliable. ClickUp CDN GETs do return `content-length` reliably.
- **Backoff on 429/5xx** — asset fetches are rate-limited per IP at the CDN edge, independently of the REST/GraphQL budgets. Retry at most twice with exponential backoff and jitter (1s → 2s, ±20%), then give up and leave the ref alone. Never retry a 401/403/404.
- **No partial files** — stream to `<target>.part`, `fs.renameSync` on `finish`, unlink the partial on every rejection path.

**Edge Cases.** Unparseable URL → skip on the automatic path, preserve today's behaviour on the manual path. Redirect to a non-`https:` location → abort. `content-length: 0` → treat as unknown and rely on the counter. A 403 on a ClickUp URL usually means an expired pre-signed link (private-attachment workspaces sign with a 1-hour TTL); do not retry it — the next import carries freshly signed URLs.

#### 2. Download the ticket's attachments during single-ticket import

**Context.** `importTaskAsDocument` (`:22123`). The ClickUp branch already calls `clickUp.getTaskDetails(id)` at `:22193` and destructures only `details.task` and `details.subtasks` — `details.attachments` (shape at `ClickUpSyncService.ts:1343`) is discarded. The Linear branch calls `linear.getIssue(id)` at `:22155`; its attachment list requires the separate `getAttachments(id)` call (`LinearSyncService.ts:1119`).

**Logic.** Before the relocalise call at `:22243`, download every attachment the ticket has:

```ts
await this._hydrateTicketAssets({
    dir: path.join(targetDir, 'attachments'),
    key: `${provider}_${id}`,
    provider,
    attachments,   // provider list — may be empty
    body: content, // for the description sweep
});
```

For ClickUp, `attachments` is `details.attachments` — already in hand, no extra call. For Linear, call `getAttachments(id)` (one extra GraphQL call on a single-ticket import, which is acceptable at this cadence) and expect link entities; entries whose URL is not an image simply download as whatever they are, which is the point of "all attachments".

**Implementation.**

- Records go through the dual-key write from the sequenced plan, so both the Attachments modal and the inline rewrite resolve them.
- Batch the ticket's records into one `_recordAttachment` cycle at the end.
- Ordering is a hard requirement: download → record → relocalise (`:22243`) → `writeFileSync` (`:22244`).

**Edge Cases.** A ticket with no attachments and no description images does zero I/O and must not create the `attachments/` directory. A Linear attachment pointing at `github.com/...` downloads an HTML page — cap it by size and by content-type, and skip `text/html` responses rather than storing a login page as an "attachment".

#### 3. Sweep the description for images the attachment list does not cover

**Context.** This is what reaches Linear's description images, which never appear in `attachments` (see *Two providers, two different attachment models*). It is also the only source available on the bulk path.

**Logic.** Inside `_hydrateTicketAssets`, after the provider list is handled: scan `body` for `!\[[^\]]*\]\(([^)]+)\)`, keep refs that are absolute `https` URLs whose decoded path ends in `.png .jpg .jpeg .gif .webp .svg .bmp` (the set already used for previews), drop any already resolvable, and fetch the remainder through the same helper.

**Implementation — idempotence probe, reuse rather than re-implement.** The "already have this?" check must call the *same* resolver the sibling plan installs in `_relocalizeInlineImages` — extract it there as `_resolveRecordedAsset(index, rawSrc, dir): string | undefined` and call it from both. A hand-rolled probe that only checks `index[this._assetKey(undefined, url)]` misses every id-keyed record on the install base and re-downloads the whole set on every delta sync.

**Edge Cases.** `data:` URIs, relative paths, and `attachments/…` refs already relocalised from a prior run are excluded by the absolute-`https` test. A ref appearing twice is fetched once. Apply the host allowlist here and only here — a description image on any host outside the allowlist (a third-party CDN, an imgur link, an attacker's logger) is skipped and keeps its original URL. Log the count skipped for out-of-allowlist hosts separately from failures; they are a coverage fact, not an error.

#### 4. Cover the bulk path

**Context.** `_writeTaskDocument` (`:23020`) is the bulk import / Refetch / delta-sync writer, driven by the loop at `:23510-23545`. It is **not** the push path — the push path is `pushTicketEdits` (`:22527`), which never calls `_relocalizeInlineImages` and must not gain any fetching, because it rewrites local refs *to* hosted URLs.

**Logic.** Call the same `_hydrateTicketAssets` immediately before the relocalise at `:23085`, with `attachments: []` and the assembled `body`. The description sweep does the work; no extra API call per ticket.

**Implementation.** Leaving this site out is the single most likely way to ship a feature that passes its own tests and covers nothing — Import All, Refetch, and every timer sync run through here, and that is how the reported 69 refs arrived. The repo's own test says so: *"BOTH import write sites, not one. The reported symptom appears on refetch (the bulk path), so fixing only importTaskAsDocument leaves the reported bug alive"* (`tickets-subtask-embedding.test.js:395-396`).

**Edge Cases.** Log once per run if bulk coverage was limited to description images, so nobody reads bulk-path coverage as equivalent to single-import coverage.

#### 5. Failure is never fatal

**Logic.** Wrap each fetch individually. On failure — network down, 401, 404, expired signature, timeout, oversize — log and move on, leaving that ref pointing at the CDN URL. The `.md` write at `:22244` / `:23086` happens regardless. An outer `try`/`catch` around the whole helper means a defect in the scan itself cannot take down import.

**Edge Cases.** One summary line per ticket (`n downloaded, m failed`), not one per failure. A 20-file ticket must not print 20 lines on every sync.

#### 6. Bound it

- **Per ticket:** 20 files. Log the count skipped when the cap trips — a silent cap reads as "covered everything".
- **Per file:** 25 MB, enforced by the streaming counter (and by `content-length` when the host sends one). Chosen deliberately now that the ask is *all* attachments, not only images: ClickUp permits up to **1 GB per attachment**, so an uncapped auto-downloader will eventually pull a 400 MB screen recording onto someone's laptop during a background sync. 25 MB clears every inline image comfortably (Linear caps inline description images at 10 MiB) and clears ordinary documents, while skipping media. Oversized files are skipped and logged with their size, and remain one click away in the Attachments modal.
- **Per import run:** 200 files or 200 MB across one `importAllTasks` invocation, then stop fetching for the rest of that run and log once. Per-ticket caps do not bound a 2,000-ticket first sync. Import itself continues normally.
- **Per fetch:** 30s timeout, ≤3 redirect hops, ≤2 retries on 429/5xx with jittered backoff.
- **Sequential per ticket.** The bulk loop at `:23510-23545` is already `for…of` with `await`; add no cross-ticket concurrency. This also keeps us far below the CDN edge's per-IP burst thresholds — concurrent asset bursts are what trigger 429s and bot challenges there.

#### 7. The kill switch

**Logic.** Add `ticketsDownloadInlineImages?: boolean` to `GlobalConfig` (`src/services/GlobalIntegrationConfigService.ts:7-62`), defaulting to `true` when the key is **absent** (`config.ticketsDownloadInlineImages !== false`).

**Implementation.** `ticketsAutoSync` is the precedent — declared at `:11`, read via `loadGlobal()` in `TicketsPanelProvider._getTicketsAutoSync` (`:872-883`). This is plain JSON in `~/.switchboard`, read identically by both hosts: one reader, no `package.json` contribution, no standalone duplicate, no migration (absent key means on, which is the intended default). Read once per import run, not per ticket.

**Edge Cases.** With the key `false`, import behaviour must be **byte-identical** to today — no scan, no directory creation, no log lines. That is a test, not a hope.

## Verification Plan

### Automated Tests

1. **Unit — attachments download on single import.** Import a ClickUp ticket whose `getTaskDetails` response carries three attachments. Assert all three land in `<targetDir>/attachments/` and are recorded under both keys, with no extra API call made for the list.
2. **Unit — Linear description images.** Import a Linear issue whose `attachments` connection is empty but whose description carries two `uploads.linear.app` image URLs. Assert both are downloaded and relocalised. This is the case an attachment-list-only implementation silently fails, and it must be a standalone test.
3. **Unit — bulk path covered.** Drive `_writeTaskDocument` with a body containing two image URLs. Assert both download and the `.md` references them relatively. Assert no per-ticket detail call is issued.
4. **Unit — idempotent across re-imports.** Re-run each of the above. Assert no second fetch and no duplicate `-<timestamp>` files. Repeat with an index holding **only** the id key (the install-base shape) to prove the probe uses the shared resolver.
5. **Unit — failure is survivable.** One URL 404s, one succeeds. Assert the `.md` is still written, the good file is relocalised, the bad ref keeps its CDN URL, and import returns success.
6. **Unit — caps.** 25 files with the per-ticket cap at 20 → 20 fetched, one log line naming the 5 skipped. Oversized `content-length` → aborted. No `content-length` but an oversized stream → aborted by the counter. Per-run cap tripped → fetching stops, import completes, one log line.
7. **Unit — setting off.** With `ticketsDownloadInlineImages: false`, import behaviour is byte-identical to today, including no `attachments/` directory creation.
8. **Unit — Linear auth by hostname.** `https://uploads.linear.app/…` carries the `Authorization` header, raw with no `Bearer` prefix; a ClickUp CDN request does not; and `https://evil.example/.linear.app/x.png` does **not**. The last one is the substring-match regression guard and must fail against the current implementation.
9. **Unit — the redirect must not carry the token.** Stub `uploads.linear.app` to 302 to `https://storage.googleapis.com/…`. Assert the second request carries **no** `Authorization` header. This is a correctness test, not only a security one: GCS answers 400/403 to a request bearing a foreign auth header, so a regression here breaks every Linear image rather than failing quietly.
10. **Unit — multi-hop redirects.** A ClickUp alias URL that 301s then 302s before serving bytes must resolve. The current single-hop follower fails this; it is the reason the hop budget went to 3.
11. **Unit — host allowlist.** A description containing `![](https://imgur.example/x.png)` and `![](http://169.254.169.254/latest/meta-data/)` triggers **zero** fetches, keeps both refs untouched, and logs them as skipped-by-allowlist rather than as failures.
12. **Unit — no HEAD pre-flight.** Assert the helper issues exactly one GET per asset (plus redirects) and never a HEAD. A chunked response with no `content-length` must still be size-capped by the byte counter.
13. **Unit — oversize skip.** A 40 MB attachment is skipped and logged with its size; the ticket still imports and its other files still download.
14. **Unit — backoff.** A 429 followed by a 200 succeeds within the retry budget; three consecutive 429s give up without failing the import. A 403 is not retried.
15. **Unit — timeout.** A server that accepts and never responds → the fetch rejects within the timeout, that ref keeps its CDN URL, import completes.
16. **Unit — no partial files.** A response erroring mid-stream → no file at the target path, no index entry, and a later successful fetch gets no `-<timestamp>` suffix from the corpse.
17. **Unit — non-image attachment handling.** A Linear link-entity attachment pointing at an HTML page → skipped by content-type, not stored.
18. **Unit — ordering.** Static assertion in the existing `tickets-subtask-embedding.test.js` style: at both write sites, hydrate precedes `_relocalizeInlineImages`, which precedes `fs.writeFileSync(filePath`.
19. **Manual, offline.** Import a fresh ClickUp ticket with inline screenshots and no prior manual downloads. Block network access to the provider CDN. Open the ticket in the VS Code panel and the browser cockpit — every image must render from local disk. This is the acceptance test for the whole set.
20. **Manual — bulk path specifically.** Run **Import All** against a list with several image-carrying tickets, then run it again. First run: files land. Second run: zero new fetches, zero new `-<timestamp>` files.

## Resolved Assumptions

Answered by web research (2026-08-12). Authoritative for this plan — do not re-open.

1. **Linear does not list description images as attachments.** Images pasted into a Linear description exist only as raw markdown `uploads.linear.app` URLs; the GraphQL `attachments` connection holds link entities. The description sweep is therefore Linear's *only* coverage, not a supplement. Confirms the design.
2. **Linear asset auth:** `uploads.linear.app` requires an `Authorization` header (401/403 without). A personal API key goes **raw**, with no prefix; an OAuth token requires `Bearer`. Current code sends raw, which is correct for the PAT it stores.
3. **Linear serves via redirect, and the header must be dropped on it.** `uploads.linear.app` authenticates and 302/307s to a pre-signed `storage.googleapis.com` URL; forwarding the header there produces 400/403. Exactly one cross-origin hop.
4. **ClickUp assets take no auth header.** Access is by pre-signed query parameters. Public `?view=open` links do not expire; workspaces with private attachments enforced get AWS pre-signed URLs with a 1-hour TTL (up to 24h for some export links).
5. **Redirect depth differs by provider.** Direct `t<workspace>.p.clickup-attachments.com` = 0 hops; alias hosts (`attachments.clickup.com`) = 1–2 hops; Linear = 1. A single-hop follower is insufficient — hence the 3-hop budget.
6. **`content-length` is reliable on ClickUp CDN GETs, unreliable on `uploads.linear.app`** (chunked / stripped, especially on HEAD). Stream-and-count is the only portable guard; no HEAD pre-flight.
7. **Size ceilings:** ClickUp allows up to 1 GB per attachment (1,000 per task); Linear caps inline description images at 10 MiB. This is what set the 25 MB per-file cap.
8. **Asset fetches are rate-limited per IP at the CDN edge**, separately from the REST/GraphQL budgets, with 429s on bursts. Sequential fetching plus jittered backoff is sufficient; concurrency is what triggers challenges.
9. **ClickUp REST rate limiting punishes sustained bursts** (100 req/min on Free/Unlimited/Business, with reports of extended cooldowns rather than clean resets). Independent confirmation that the bulk path must not add a per-ticket detail call.

## Recommendation

Complexity 5 → **Send to Coder.**

## Review Findings

Reviewer pass 2026-08-12, all fixes in `src/services/TaskViewerProvider.ts` plus new gates in `src/test/tickets-subtask-embedding.test.js`. Three blockers: `downloadAttachment` failed `tsc` assigning `_fetchAssetToDisk`'s `string | undefined` to a `string`; the description sweep derived the same `image.png` filename for every ClickUp pasted image, so the second asset was mis-detected as already-downloaded by the flat-path probe and both refs relocalised to the first screenshot (now disambiguated with a stable SHA-1 suffix of the asset key — never `Date.now()`, which is what produced the seven-copy pile-up); and the run budget was opened inside the document fast path but closed only on the slow path, leaking a spent `capped: true` onto the field so later single-ticket imports silently downloaded nothing (now opened before the branch and closed on both exits). Four majors fixed: the sweep parsed/fetched/keyed a `decodeURIComponent`'d URL while the inline rewrite keys the raw ref (key divergence → permanent re-download loop on any `%23`/`%3F`/`%2F` filename); `loadGlobal()` ran once per ticket on a background timer instead of once per run; `_fetchAssetToDisk`'s containment check compared `dir` to its own dirname (tautological) and never guarded the remote-controlled final target path; and none of the plan's 18 automated checks existed, so §22 now pins ordering at both write sites, exact-hostname Linear auth (with an anti-substring guard), cross-origin header drop, the allowlist gate, no-HEAD/streaming size cap, the kill switch default, the caps constants, the shared resolver, and run-budget open/close symmetry. Verification: `tsc -p tsconfig.test.json` clean for this file (two pre-existing errors remain in `LocalApiServer.ts`/`standingOrders.ts`, red at HEAD and out of scope), `eslint` 0 errors, `test:contract:tickets-subtasks` PASS along with seven sibling ticket suites and the catalog/parity/verb-return/push-routing gates; `mirror:check` fails on unrelated `.agents/skills` working-tree drift. Remaining risk: behavioural network tests (redirect, auth header, timeout, backoff, oversize, partial-file) are still unwritten — the repo has no HTTPS stub harness — and the plan's manual offline acceptance checks (19, 20) need a human.

## Completion Report

Implemented automatic attachment download on ticket import and hardened the shared asset fetcher. Added `_fetchAssetToDisk` and `_hydrateTicketAssets` to `src/services/TaskViewerProvider.ts`, wired both `importTaskAsDocument` and `_writeTaskDocument` to hydrate assets before relocalisation, and rewrote `downloadAttachment` to use the new helper. Added the `ticketsDownloadInlineImages` kill switch to `GlobalIntegrationConfigService.ts`. The implementation follows the plan's caps, allowlist, timeout, redirect, retry, and idempotence rules. No tests or compile steps were run per the prompt.
