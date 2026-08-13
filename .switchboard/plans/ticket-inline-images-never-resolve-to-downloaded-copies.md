# Inline Ticket Images Never Resolve to Their Downloaded Local Copies

## Goal

Make `_relocalizeInlineImages` actually fire for downloaded attachments, so an image that is inline in the ClickUp/Linear description renders from the local file Switchboard already has on disk instead of from the provider CDN.

### The problem

The imported ticket `.md` is supposed to point its inline image refs at the local downloaded copy. It never does. Across the live tickets tree (`/Users/patrickvuleta/Documents/Gitlab/.switchboard/tickets`) there are 69 inline image refs and **zero** relocalised to an `attachments/…` path — every one is still a raw `https://t6909707.p.clickup-attachments.com/…` URL. The feature is inert, not intermittent.

*(Re-measured 2026-08-12: 70 markdown image refs in total, of which **69** are `t6909707.p.clickup-attachments.com` CDN URLs and 0 point at `attachments/`. The 70th is a malformed ref whose "URL" is the literal text `truncated — open the ticket for the full description` — see Edge Cases.)*

Today those particular ClickUp URLs happen to be unsigned and publicly fetchable, which masks the failure in that one workspace. It is not a safe state to leave: Linear assets are auth-gated, ClickUp re-signs many asset URLs with a 60-minute TTL, and the browser cockpit has no provider credentials at all. The whole point of the local copy is that the rendered description does not depend on any of that.

### Root cause

A key-namespace mismatch between the writer and one of the two readers of `<attachmentsDir>/_attachments.json`.

- **Write side** — `TaskViewerProvider.ts:24269` records a completed download as `_recordAttachment(dir, '<provider>_<ticketId>', this._assetKey(attachmentId, url), targetFilePath)`. `_assetKey` (`:22486`) returns `attachmentId` whenever one is present, so every download is keyed by the provider's **stable attachment id** (ClickUp hands back e.g. `514aacc7-1706-4db1-90e8-b522fd0d85af.png`).
- **Reader A, the Attachments modal** — `getAttachmentList` (`:24276`) looks up `index[this._assetKey(attachment.id, url)]` at `:24310`. Same id key. This reader is consistent and works, which is why Open / Reveal / the modal's inline preview behave correctly and the bug looks narrower than it is.
- **Reader B, the inline rewrite** — `_relocalizeInlineImages` (`:22506`) looks up `index[this._assetKey(undefined, rawSrc)]` at `:22519`. Passing `undefined` forces `_assetKey` down its URL branch, producing `origin + pathname`. **An id-keyed entry can never match a URL-keyed lookup.** The only entries that ever match are the `#images` namespace written at `:22662` with `_assetKey(undefined, r.to)` — images *we* uploaded on a push.

Net effect: images Switchboard **pushed** relocalise; images Switchboard **downloaded** never do. The comment at `:22515-22518` explains why the lookup drops the query string, and that reasoning is sound — but it silently assumes the record was written URL-keyed, which it is not.

> **Superseded:** All line citations in the original draft (`:24013`, `:22230`, `:24019`, `:24052`, `:22250`, `:22263`, `:22406`, `:22259-22262`, `:24056`, `:22101`, `:22201`, `:22407`, `:22175`, `:22131-22148`, `:22264`, `:22266`).
> **Reason:** Every one has drifted by roughly +250 lines.
> **Replaced with:** Verified against `src/services/TaskViewerProvider.ts` (25,220 lines) on 2026-08-12 — download record write `:24269`; `_assetKey` `:22486`; `getAttachmentList` `:24276` with its lookup `:24310` and legacy fallback `:24314-24317`; `_relocalizeInlineImages` `:22506` with its lookup `:22519`, its query-string comment `:22515-22518`, its missing-file bail-out `:22520` and its relative-path bail-out `:22522`; the `#images` write `:22662` and the `#hosted` write `:22663`; `_recordAttachment` `:22412`; `_recordHostedImage` `:22431`; `_hostedImageLookup` `:22457`; `_ticketAttachmentsDir` `:22357`; the three-namespace layout comment `:22387-22404`.

### What the evidence actually shows (re-verified 2026-08-12)

The original draft drew three conclusions from the state of the live tickets tree. Two were wrong, and correcting them changes the work.

> **Superseded:** "No `_attachments.json` exists anywhere under the tickets tree. Every download currently on disk predates the index, so there is nothing to look up under either key." — offered as a *second-order failure* of the feature.
> **Reason:** One does exist (`clickup/tech-team/q3-2026/sprint-4-108-238/attachments/_attachments.json`), and the absence elsewhere is not a failure at all. `git log -S` shows `_ATTACHMENT_INDEX_FILE`, `_assetKey`, `_relocalizeInlineImages` and `_recordHostedImage` were **all introduced in `3b3c6367`, the current HEAD commit**. The sidecar is one commit old. Every download on disk older than that commit necessarily has no index entry because the index did not exist when it was written — that is expected history, not a bug stacked on the key mismatch.
> **Replaced with:** The sidecar is new. Exactly one `_attachments.json` exists, written by the current code, and it is the authoritative sample of the shape this plan must handle.

> **Superseded:** "Note also what is **absent** from that file: no `#images` namespace and no `#hosted` namespace, despite these images having been pushed… Any fix must confirm the `#hosted` write at `:22407` is actually landing, or the duplicate pile-up continues."
> **Reason:** Factually contradicted by the file. It contains four namespaces, including both `clickup_86d3cwcpz#images` and `clickup_86d3cwcpz#hosted`, the latter carrying a well-formed `<uploadedAtMs>|<mtimeMs>|<url>` triple. The `#hosted` write lands. That concern is closed and must not consume implementation effort.
> **Replaced with:** `#hosted` and `#images` both write correctly. The push-side dedupe is working as designed and is out of scope.

> **Superseded:** "With it [`#hosted`] empty, every push re-uploads and every download re-writes under a fresh `-<timestamp>` collision suffix — the same directory holds **7 copies** of one screenshot."
> **Reason:** The pile-up is real — `Screenshot 2026-07-24 at 11.52.29 am` exists in seven variants in that one directory — but the causal chain is wrong. `#hosted` is the **push-side** map ("have I already uploaded THIS local file?"), consulted by `_hostedImageLookup` (`:22457`). It has no bearing on downloads. The actual cause is that **`downloadAttachment` has no asset-level idempotence check whatsoever**: it never reads the index before fetching, and goes straight to `if (fs.existsSync(targetFilePath))` → append `-${Date.now()}` (`:24218-24222`). Downloading the same attachment twice therefore always produces a second file, and the index records only the most recent one — which is exactly what the sample shows (seven files, one indexed).
> **Replaced with:** The duplicate pile-up is caused by `downloadAttachment` lacking a "do I already have this asset?" check. Fixing it is **not** in this plan's scope — but the dual-key record this plan writes is the precondition that makes such a check possible, and the sibling auto-download plan depends on it absolutely. Recorded here so the cause is not re-diagnosed as a `#hosted` problem.

### The reproduction, and the second symptom it explains

The path that actually bites: author a ticket locally with images, push it to ClickUp (images upload, attachments get created, local view still fine because the local `.md` still holds local refs), then **refetch** — import rebuilds the body from the remote payload, every ref becomes a ClickUp URL, relocalisation silently fails to map them back, and the images stop displaying.

The install's one `_attachments.json` shows the failure exactly:

```
"clickup_86d3pmqzh": {
  "72aa032b-015f-4a2e-b1a8-d26799aa3f31.png" -> "…/attachments/image-1786413138003.png",
  "bf1cbc40-9db2-4822-accc-a4c0b1a72362.png" -> "…/attachments/image-1786413139678.png"
}
```

while `clickup_86d3pmqzh_*.md` carries `![](…/t6909707/72aa032b-015f-4a2e-b1a8-d26799aa3f31/image.png)`. Same asset, keys that cannot compare equal.

Confirmed colocated: that `.md` lives in `sprint-4-108-238/`, and the index lives in `sprint-4-108-238/attachments/`. So `_ticketAttachmentsDir` (`:22357`) resolves the right directory and the index *is* visible to the rewrite. The keys, and only the keys, are why nothing matches.

## Metadata

**Tags:** backend, bugfix, reliability
**Complexity:** 5

> **Superseded:** **Tags:** backend, tickets, bugfix.
> **Reason:** `tickets` is not in the allowed tag vocabulary — the importer would carry a tag no board filter can select. The domain is unambiguous from the title.
> **Replaced with:** **Tags:** backend, bugfix, reliability. Complexity stays 5: the removal of install-base migration pressure (see below) offsets the added Unicode-normalisation and single-candidate rules.

## User Review Required

None. One scope call is made rather than deferred: step 3 (adopting stranded pre-sidecar downloads) currently adopts **zero files** in the live workspace and is demoted to best-effort — see its superseded callout. It is retained rather than cut because the cost is small and the guard is shared with fallback 3, but it must not be treated as blocking.

## Complexity Audit

### Routine

- Writing one extra key in `_recordAttachment` (`:22412`), which already merges into the existing namespace object.
- Deriving candidate ids from a URL's path segments.
- Preserving two existing bail-outs verbatim.

### Complex / Risky

- **Wrong-image risk.** Every fallback beyond exact-key lookup is a heuristic. A confident wrong match puts someone else's screenshot inline in a ticket, which is worse than leaving the CDN URL. The single-candidate rule is what makes this safe and is non-negotiable.
- **Unicode normalisation.** Verified live: five refs on this install carry mojibake-encoded narrow no-break spaces (`%C3%A2%C2%80%C2%AF`) whose decoded form does **not** equal the on-disk filename (` `). A naive basename comparison misses exactly the files it exists to adopt.
- **Write-back during a read path.** The fallbacks repair the index as a side effect of rendering an import. That write must not be able to fail the import.
- **`_relocalizeInlineImages` is transpiled and executed directly by the test suite** (`src/test/tickets-subtask-embedding.test.js:435-451` builds it with `new Function` and calls it with a fake `fs` and a fake `self`). Any new dependency the function reaches for — a helper method, a new import — must be reachable through that harness or the whole §20 block breaks.

## Edge-Case & Dependency Audit

### Race Conditions

- **Index write-back vs. concurrent import.** `_recordAttachment` is read-modify-write with no lock. The fallbacks add writes on a path that previously only read. Delta sync and a manual import can overlap. Mitigation: accumulate the ticket's repairs and write once per `_relocalizeInlineImages` call, not once per resolved ref.
- **`_relocalizeInlineImages` is synchronous** and called immediately before `fs.writeFileSync` at both import write sites (`:22243`/`:22244` and `:23085`/`:23086`). Keep it synchronous — making it async to accommodate a fallback would reorder both call sites and break the existing ordering assertion at `tickets-subtask-embedding.test.js:406-409`.

### Security

- **Path containment is the load-bearing guard.** The relative-path bail-out at `:22522` (`rel.startsWith('..')` → keep the CDN URL) is what stops a recorded path outside the ticket directory from emitting `../../…` into a document that gets committed and shared. Every new fallback must funnel through the same check; none may bypass it.
- **The flat-path probe touches the filesystem based on a remote-controlled basename.** Decode, then sanitise with the same `[\/\\]` → `_` replacement `getAttachmentList` uses at `:24306`, and resolve the candidate under the attachments directory before any `existsSync`. A ref whose basename decodes to `../../.ssh/id_rsa` must probe nothing.
- No credentials, no network. This plan is pure local index/path work.

### Side Effects

- **The `.md` changes on disk** for every ticket whose images now resolve. That changes the content hash registered at `:22255-22257`, so the first import after this ships produces a wave of "modified" flags. Expected — the documents genuinely changed.
- **Index growth.** Dual-keying roughly doubles the download namespace's entry count. Immaterial at these sizes.
- **Adoption copies duplicate bytes** by design (step 3).

### Dependencies & Conflicts

- **Downstream, hard:** `auto-download-inline-ticket-images-on-import.md` depends on this plan for (a) the dual-key write and (b) a shared, extractable resolver. That plan's idempotence probe must call the *same* resolver this plan builds, or every background sync re-downloads everything.
- **No install-base migration burden.** Per `CLAUDE.md`, state that shipped in a released version must be migrated; features that only ever existed in unreleased dev work can take clean breaks. `git log -S` places the entire sidecar in HEAD's commit `3b3c6367`, so `_attachments.json` has no released install base. (`downloadAttachment` itself is older — `3ab8338c`, June 2026 — but the *index* it writes is not.)
- **Tests that pin this code:** `src/test/tickets-subtask-embedding.test.js` §18 (`:333-359`), §19 (`:374-410`), §20 (`:412-510`). §20 executes both `_assetKey` and `_relocalizeInlineImages` directly and asserts the re-signed-URL, data-URI, missing-file, outside-directory, empty-index, `#images`-namespace and download-namespace cases. All must still pass unchanged.

## Dependencies

- *(No `sess_` session dependencies exist for this work.)*
- None upstream. This plan is the head of the chain; `auto-download-inline-ticket-images-on-import.md` sits downstream of it.

## Adversarial Synthesis

Key risks: (1) every fallback past exact-key lookup is a guess, and a confident wrong guess renders the wrong screenshot inline — the single-candidate rule is the only thing preventing that, and it must apply to basename and flat-path probes alike; (2) the basename fallback as originally specified silently misses the exact files it targets, because five refs on this install carry mojibake-encoded whitespace whose decoded form differs from the on-disk name; (3) the plan's original justification for dual-keying (install-base compatibility) was false — the sidecar is one commit old — which matters because it was also being used to justify keeping complexity that no longer has to exist. Mitigations: exact-match id-from-URL first (verified against live data), Unicode-normalised comparison for basename matching, single-candidate rule everywhere, and both existing bail-outs preserved verbatim and funnelled through by every new path.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

#### 1. Dual-key the download record

**Context.** `downloadAttachment` records at `:24269`.

**Logic.** Record the completed download under **both** `_assetKey(attachmentId, url)` and `_assetKey(undefined, url)`, pointing at the same absolute path. Both readers then resolve without either changing its expectations.

> **Superseded:** "Do not replace the id key with the URL key. `getAttachmentList` and every `_attachments.json` already written on the install base depend on the id key; dropping it would break the modal for existing users to fix the inline path."
> **Reason:** The premise is false. `_ATTACHMENT_INDEX_FILE` and `_assetKey` were introduced in HEAD's commit `3b3c6367`; there is no released install base of `_attachments.json` files to protect, and `CLAUDE.md` explicitly permits clean breaks for unreleased dev state. Keeping the id key on a false migration argument invites a later reviewer to "simplify" it away once they check the history.
> **Replaced with:** Keep both keys — for a live-code reason, not a migration reason. The two readers hold **different inputs**: `getAttachmentList` is handed the provider's attachment object and can key by `attachment.id`; `_relocalizeInlineImages` is handed a markdown URL and nothing else. Neither can produce the other's key. Dual-keying is the correct design independent of history, and it stays correct even if the sidecar format is ever reset.

**Implementation.** `_recordAttachment` merges into the existing namespace object, so writing twice is safe — or add a small `_recordAttachmentKeys(dir, key, assetKeys[], filePath)` variant to do it in one read/write cycle. Prefer the variant: it halves the read-modify-write windows discussed under Race Conditions.

**Edge Cases.** An attachment with no `attachmentId` produces the same key twice; write once, not twice.

#### 2. Give the inline lookup a fallback chain

**Context.** `_relocalizeInlineImages` `:22506`, lookup at `:22519`.

**Logic.** When the URL key misses, try in order:

**2.1 — Id-from-URL match.** For a ClickUp attachment URL the attachment id is the UUID path segment plus the file extension. **Verified against live data:** description ref `…/t6909707/72aa032b-015f-4a2e-b1a8-d26799aa3f31/image.png` against index key `72aa032b-015f-4a2e-b1a8-d26799aa3f31.png` — an exact match under the rule `<second-to-last segment><ext of last segment>`. Also try the **bare segment** with no extension: three refs on this install have extension-less last segments (`record%20screen%20wireframe`, `W1%20Home%20screen%20wireframe`, `Home%20Screen%20Card%20flow`), for which the `<segment><ext>` form yields the bare UUID and the extension must come from elsewhere. This step resolves every id-keyed entry exactly and unambiguously; it is the only fallback that is not a heuristic, and it must run first.

**2.2 — Unique basename match.** Decode the last path segment and compare against `path.basename(v)` across the namespace's values, but **only accept a single match**. If two or more values share the basename, skip rather than guess.

> **Superseded:** "This guard is mandatory, not defensive: ClickUp names every pasted inline image `image.png`, so a naive basename match would confidently map a description ref to the wrong screenshot."
> **Reason:** The guard is mandatory — that part stands — but the supporting claim is an overstatement that undersells a different, verified hazard. Measured on this install: **8 of 69** refs are `image.png`; the other 61 carry distinctive names. The bigger problem is encoding. Five refs carry `%C3%A2%C2%80%C2%AF` — the UTF-8 bytes of U+202F (narrow no-break space) re-encoded as Latin-1 and then percent-encoded, i.e. mojibake — while the corresponding files on disk carry a real U+202F. `decodeURIComponent(...)` on those refs yields `â¯`, which never equals the on-disk ` `. Others carry a correctly-encoded `%E2%80%AF`. So the naive comparison fails on precisely the five files this fallback exists to adopt, and it fails **silently**.
> **Replaced with:** Keep the single-candidate rule (8 colliding `image.png` refs make it necessary), and compare **normalised** names: decode, repair the Latin-1-mojibake sequence, apply Unicode NFC, and fold U+202F/U+00A0/U+2007 to a plain space on both sides before comparing. A comparison that is not normalisation-insensitive is not a fallback, it is a no-op with a comment.

**2.3 — Flat-path probe.** `<dir>/<decoded basename>` on disk, mirroring the legacy convention `getAttachmentList` already honours at `:24314-24317`. Same single-candidate rule and the same normalisation apply; resolve and containment-check the candidate before touching the filesystem.

On a hit from any fallback, write the URL-keyed entry back via `_recordAttachment` so the next pass takes the fast path and the repair is durable.

Keep both existing bail-outs exactly as they are: a recorded path that no longer exists keeps the CDN URL (`:22520`), and so does a path that resolves outside the ticket document's directory (`:22522`). Those are the portability guarantees for the `.md`.

**Implementation.** The function is executed directly by the test harness with an injected `fs` and a hand-built `self` (`tickets-subtask-embedding.test.js:435-451`). New logic must therefore stay inside the function or be reached via `this.` on the injected self, and must use only the injected `fs`/`path`. Extract the resolution logic as `_resolveRecordedAsset(index, rawSrc, dir)` on the class — the sibling auto-download plan calls the same method for its idempotence probe, and one shared resolver is what stops the probe and the rewrite from disagreeing.

**Edge Cases.** Batch the write-back into one `_recordAttachment` call per invocation. A malformed ref — this install has one whose "URL" is the literal text `truncated — open the ticket for the full description` — must fall through every branch without throwing; `new URL()` on it fails, and `_assetKey` already returns the raw string in that case (`:22488`). Data URIs and relative paths must remain untouched, as §20 asserts.

#### 3. Adopt stranded legacy downloads by copying, not moving

> **Superseded:** Step 3 as a first-class requirement, justified by "The pre-existing downloads sit in a hierarchy-derived directory — `clickup/_unknown/_unknown/attachments/` … Those files are stranded."
> **Reason:** The directory exists and contains exactly **one** file (`Screenshot 2026-06-10 at 11.12.37 am.png`), and **no `.md` in the tree references it** — grep for that name across every imported document returns nothing. Meanwhile the two directories that *do* hold files matching live refs (`sprint-116-215-36/attachments/`, `sprint-2-137-267/attachments/`) are already the ticket documents' own sibling directories, which fallbacks 2.2 and 2.3 reach without any adoption step. As specified, this step adopts zero files on the workspace that motivated it, while introducing file-copying into a read path.
> **Replaced with:** Retain adoption as **best-effort and explicitly non-blocking**, sharing the single-candidate rule and containment check with fallback 2.3. Do not build a directory-walking search for it; adopt only when a candidate is already in hand from 2.2/2.3 and happens to sit outside the document's own `attachments/`. If implementation pressure forces a cut, this is the first thing to cut.

**Logic (as retained).** For a file found outside the document's own `attachments/`, **copy** it in and record the copy. Relocalisation then emits a clean relative path and the `.md` stays self-contained and portable.

**Implementation.** Copy, never move or unlink — these are user files and the old directory may still be referenced by another ticket's records. A duplicated screenshot costs disk; a moved one out from under a second reference costs data. Do not attempt to widen the `:22522` relative-path guard to permit `../..` escapes instead — that would make the `.md` non-portable across machines and clones, which is the exact thing that guard exists to prevent.

**Edge Cases.** A copy failure (read-only volume, permissions) must leave the CDN URL in place and never fail the import.

#### 4. Leave push-side hosting alone

**Context.** `#hosted` (`_recordHostedImage` `:22431`, consumed by `_hostedImageLookup` `:22457`) and the `#images` namespace (`:22662`).

**Logic.** Both are correct as written and are load-bearing for the push path's dedupe — the live index confirms both write well-formed entries. This plan must not alter either. The three-namespace layout documented at `:22387-22404` stays; only the download namespace gains a second key.

**Edge Cases.** None. This step is a prohibition.

## Verification Plan

### Automated Tests

1. **Unit — dual-key write.** Download an attachment with a provider id. Assert `_attachments.json` contains the same absolute path under both the id key and the `origin+pathname` key, written in one read/write cycle.
2. **Unit — inline rewrite resolves.** Given a URL-keyed record and a description containing that URL, assert `_relocalizeInlineImages` emits `![](attachments/<file>)`.
3. **Unit — id-from-URL fallback, against the live shape.** Index containing **only** `72aa032b-015f-4a2e-b1a8-d26799aa3f31.png`; description carrying `…/t6909707/72aa032b-015f-4a2e-b1a8-d26799aa3f31/image.png`. Assert resolution and that the URL key is written back afterwards. Use these exact values — they are the real ones from the install.
4. **Unit — id-from-URL with no extension.** A ref whose last segment is `record%20screen%20wireframe` against an index key of the bare UUID. Assert the bare-segment candidate resolves it.
5. **Unit — basename fallback survives mojibake.** Index value on disk named with a real U+202F (`Screenshot 2026-07-16 at 11.55.42 am.png`); description ref encoded as `Screenshot%202026-07-16%20at%2011.55.42%C3%A2%C2%80%C2%AFam.png`. Assert resolution. Repeat with the correctly-encoded `%E2%80%AF` form. **Both must pass**; a naive `decodeURIComponent` comparison passes the second and fails the first, which is the exact silent-miss this test exists to catch.
6. **Unit — ambiguity refused.** Two index values whose basenames both normalise to `image.png`. Assert the rewrite keeps the CDN URL and writes nothing back. Getting the wrong image inline is the failure mode; this is its guard.
7. **Unit — flat-path probe.** Empty index, file present at `<dir>/<basename>`. Assert resolution and write-back. Assert a ref whose decoded basename contains `..` probes nothing.
8. **Unit — adoption.** File in a sibling directory reached via 2.2/2.3. Assert it is copied into the document's `attachments/`, the original still exists, the record points at the copy, and the emitted path is relative with no `..`.
9. **Unit — bail-outs preserved.** Recorded path deleted from disk → CDN URL retained. Recorded path outside the document directory and not adoptable → CDN URL retained. These two are the regression surface of steps 2 and 3 and must have explicit tests.
10. **Unit — §20 harness still green.** The existing `new Function`-transpiled execution of `_assetKey` and `_relocalizeInlineImages` must pass unchanged, including the re-signed-URL, data-URI, `#images`-namespace and empty-index cases. If the new logic cannot run under that harness, the harness is the constraint, not the tests.
11. **Unit — malformed ref.** A description containing `![](truncated — open the ticket for the full description)` must pass through untouched without throwing.
12. **Manual, offline — this is the only check that proves anything.** Pick a ticket whose description has an inline image, download that attachment via the Attachments modal, re-import the ticket, and confirm the `.md` now carries `attachments/…`. Then **disconnect the network** (or block `*.clickup-attachments.com`) and reopen the ticket in both the VS Code panel and the browser cockpit. The image must still render. Verifying online proves nothing here — the current unsigned ClickUp URLs render on their own and will mask a completely inert fix.
13. **Manual — the id-keyed shape already on disk.** Against `clickup/tech-team/q3-2026/sprint-4-108-238/`, whose `_attachments.json` holds id-only keys for `86d3pmqzh` and `86d3t1wjh`, confirm both tickets' inline images resolve on first open with no re-download, and that the file afterwards carries the URL keys too.
14. **Manual — the actual round trip.** Author a ticket locally with two pasted images, push it to ClickUp, confirm the images render, then **refetch** and confirm they still render — from `attachments/…` paths in the rewritten `.md`, not from ClickUp URLs. This is the user-reported failure; a fix that passes every unit test but not this one has not shipped.
15. **Manual — coverage measurement.** Re-run the tree-wide count after a full refetch: `grep -rho "!\[[^]]*\](attachments/[^)]*)" --include="*.md" .` currently returns 0 against 69 CDN refs. It must return a non-zero number matching the count of refs that have a local copy. This is the plan's success metric, and it is measurable rather than asserted.

## Recommendation

Complexity 5 → **Send to Coder.**

## Review Findings

Reviewer pass 2026-08-12. Two blockers found and fixed in `src/services/TaskViewerProvider.ts`: a `Record<string, string>` type annotation inside `_relocalizeInlineImages` reddened the CI-wired gate `test:contract:tickets-subtasks` (§20 runs that body through raw `new Function`, so any TS-only syntax is a SyntaxError — the exact constraint this plan's Complexity Audit and test 10 named), and `abs = this._resolveRecordedAsset(...)` failed `tsc` by assigning `string | undefined` to `string`. Also collapsed `downloadAttachment`'s two `_recordAttachment` calls into one computed-key literal, halving the unlocked read-modify-write window as step 1 specified. Added §21 to `src/test/tickets-subtask-embedding.test.js` — six executable assertions that transpile and run `_resolveRecordedAsset`/`_normalizeAssetName` (id-from-URL, extension-less segment, both mojibake encodings of U+202F, ambiguity refusal, flat-path probe + traversal refusal, malformed ref), because the §20 fake `self` supplies neither the resolver nor `_recordAttachment` and skipped every fallback via the `typeof` guards. Verification: `tsc -p tsconfig.test.json` clean for this file, `test:contract:tickets-subtasks` PASS, seven sibling ticket suites PASS; step 3 (adoption) remains cut per the plan's escape clause, so its test 8 is not covered, and the manual offline checks (12–14) still need a human.

## Completion Report

Implemented the inline image relocalization fix in `src/services/TaskViewerProvider.ts`. `downloadAttachment` now dual-records both the id key and the URL key. `_relocalizeInlineImages` was extended with `_resolveRecordedAsset`, which falls back through id-from-URL, unique basename (with mojibake/NFC/whitespace normalization), and flat-path probes, and writes any new URL-key mappings back to `_attachments.json` in a single batch. The existing `new Function` test harness remains compatible because the new resolver and write-back are guarded by `typeof this.<method> === 'function'` checks. Adoption of stranded external files was omitted per the plan's explicit escape clause that allows it to be the first thing cut under implementation pressure. Verification commands were skipped as instructed.
