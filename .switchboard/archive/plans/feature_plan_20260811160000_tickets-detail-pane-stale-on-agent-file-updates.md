# Tickets detail pane serves stale text and images after an agent edits the ticket file

## Goal

Make the Tickets detail pane reflect an agent's edit to a ticket's local `.md` file (and its
`attachments/` images) the moment the edit lands — with no reselect, no tab switch, no manual
Refresh — in both the VS Code webview and the standalone browser cockpit.

### Reported behaviour

Agent writes to a ticket file while that ticket is open in `tickets.html`. The detail pane keeps
showing the previous content. Images are the most visible case (a regenerated diagram or a
re-downloaded attachment keeps rendering the old bitmap); text is stale "sometimes". The only
reliable workaround is to click a different ticket card and then click back — which is exactly the
diagnostic signature that matters: the *data* is reachable, but the render is being suppressed.

### Root cause analysis

The refresh path is: `TicketsPanelProvider._setupTicketsViewWatcher` (file watcher, armed per
workspace root via `setupTicketsWatcher`) → `postMessageToWebview({ type: 'ticketFileChanged', … })`
→ `tickets.js` case `'ticketFileChanged'` (`src/webview/tickets.js:7729`) → `renderTicketsTab()` →
`renderTicketsLinearTaskDetail` / `renderTicketsClickUpTaskDetail`.

Seven independent defects sit on that path. They are not alternatives — they stack, which is why the
symptom presents as "images always stale, text sometimes stale".

> **Superseded:** "Five independent defects sit on that path."
> **Reason:** Two more were found during the improve pass, and both are load-bearing for the image
> half of the goal. Defect 6: `src/standalone/bootstrap.ts` never calls
> `ticketsProvider.setApiServer(server)` (verified at `bootstrap.ts:1713-1717`, which wires Design,
> Setup, TaskViewer, Planning and Kanban — Tickets is absent). Defect 7: the asset route's allow-list
> never unions `getTicketsAssetRoots`, so assets under a configured `ticketSaveLocation` 403 at fetch
> time in both hosts.
> **Replaced with:** Seven defects; the new ones are defects 6 and 7 below.

**1. The watcher is blind to every non-`.md` file, so an image change produces no event at all.**
`src/services/TicketsPanelProvider.ts:694`:

```ts
const watcher = this._seams().watcher.watchFolder(folder, (event, filePath) => {
    if (!filePath.endsWith('.md')) { return; }   // ← attachments/*.png dropped here
```

Ticket images live at `<ticketDir>/attachments/<name>` (written by the attach handler at
`TicketsPanelProvider.ts:3146`). An agent that overwrites `attachments/flow.png` in place changes no
`.md` byte, so `handleTicketFileEvent` never runs and no `ticketFileChanged` is ever posted. This is
the whole explanation for "images are stale" — nothing is even trying to refresh.

**2. The asset URL is content-independent, so identical HTML can never signal an image change.**
`_buildLocalAssetUrl` (`TicketsPanelProvider.ts:524`) returns
`http://127.0.0.1:<port>/design/asset?root=…&path=…` — no version token. When the bytes at `path`
change, the emitted markdown, and therefore the rendered HTML string, is byte-identical. That makes
the change *undetectable by every downstream equality check* (defects 3 and 4). The server does send
`Cache-Control: no-cache` (`LocalApiServer.ts:1026`), so the bytes are re-fetched whenever a *new*
request is made — the failure is that no new request is made, because the `<img>` node is never
recreated. That in turn is why reselecting works: selecting ticket B then A back writes a different
`contentHtml` both times, which replaces `innerHTML`, destroys and recreates the `<img>`, and fires
a fresh no-cache GET.

**3. The webview's `hasChanged` guard suppresses the re-render on any body-identical change.**
`src/webview/tickets.js:7741`:

```js
if (selectedClickUpIssue?.renderedDescriptionHtml !== rendered) { … hasChanged = true; }
…
if (hasChanged) { renderTicketsTab(); }
```

The comparison is the rendered *description body only*. Combined with defect 2, an image-only change
compares equal and no render happens. It also means a frontmatter-only edit renders nothing, because
`handleTicketFileEvent` strips frontmatter (`TicketsPanelProvider.ts:650`) before building `content`.

**4. `ticketFileChanged` never applies the new title to the selected ticket.**
The provider computes `title` from the file's H1 and sends it (`TicketsPanelProvider.ts:656`), but
the webview arm uses `message.title` *only* when synthesising a placeholder cache entry for a
**non-selected** ticket (`tickets.js:7767`, `:7774`). For the selected ticket it writes exactly two
fields — `renderedDescriptionHtml` and `descriptionMarkdown` — and leaves `issue.title` /
`task.title` untouched. Both detail renderers draw the heading from that stale object
(`tickets.js:3337`, `:3442`), so an agent retitling a ticket leaves the old `<h1>` on screen. This is
"sometimes text is stale": the description body updates, the heading above it does not.

The identical bug exists in the sibling arm. `case 'localTicketFileRead'` (`tickets.js:7682`) rebuilds
the selected object as `task: existing?.task || { … title: message.title … }` — when a cache entry
already exists (the normal case), the `||` short-circuits and `message.title` is discarded there too.
So exiting edit mode, which routes through `_refreshSelectedTicketFromFile()` → `readLocalTicketFile`,
*also* leaves a stale heading. One fix must cover both arms.

> **Superseded:** "Status, priority, assignee, subtasks, comments and attachments are likewise never
> refreshed from the file."
> **Reason:** Factually wrong for the detail pane, and it drove a payload change that buys nothing.
> Both detail renderers build `contentHtml` from exactly four parts — `<h1>{title}</h1>`, the
> rendered description, a Comments block and an Attachments block (`tickets.js:3337-3367` for Linear,
> `:3442-3472` for ClickUp). **Status, priority and assignee are not rendered in the detail pane at
> all.** They appear on the sidebar cards, which `ticketFileChanged` already refreshes via
> `_scheduleSidebarRefreshFromFiles()` → `listLocalTicketFiles`, and that path re-parses frontmatter
> for `status` / `priority` / `assignees` on every reload (`TicketsPanelProvider.ts:2130-2153`). The
> file-derived shapes also differ from the API shapes already held on `task` (frontmatter `priority`
> is `{priority,color,orderindex}`), so writing them onto `task.priority` risks corrupting the
> sidebar and the priority/assignee filters that read those objects.
> **Replaced with:** Defect 4 is scoped to the **title** only, and the fix is applied in one shared
> place so `localTicketFileRead` gets it too. The frontmatter-fields payload change (old Proposed
> Change 3) is dropped — see the Superseded callout there.

**5. Two hosts get no events at all.**
   - *Standalone / browser cockpit.* `bootstrap.ts:610` injects `createVscodeHostSeams(...)`, whose
     `VscodeHostFileWatcher.watchFolder` calls `vscode.workspace.createFileSystemWatcher`
     (`hostSeams.ts:553`). Under the standalone shim that function is a **no-op**
     (`src/standalone/vscodeShim.ts:217`). `TicketsPanelProvider` is constructed in standalone
     (`bootstrap.ts:633`) and `setupTicketsWatcher` runs — the verb is allowlisted
     (`src/generated/verbAllowlist.ts:11`) and the router is wired (`bootstrap.ts:1647`) — so the
     arming looks healthy; it attaches zero live watchers. A real implementation already exists
     (`createStandaloneFolderWatcher`, `src/standalone/hostServices.ts:32`) and its own comment says
     it was written *for this watcher*, but it lives in `createHeadlessHostSeams`, which
     `hostServices.ts:360` documents as NOT WIRED.
   - *Out-of-workspace tickets folders in the editor.* `_resolveTicketsWatchFolders`
     (`TicketsPanelProvider.ts:575`) includes both providers' configured `ticketSaveLocation`, which
     are global settings and routinely point outside every workspace root. This repo already
     documents that `createFileSystemWatcher` drops events for such paths and carries a native
     `fs.watch` fallback in `DesignPanelProvider._setupNativeFolderWatchFallback`
     (`DesignPanelProvider.ts:1029`), `TaskViewerProvider.ts:13464` and `GlobalPlanWatcherService`.
     The tickets watcher has no such fallback.

**6. Standalone never hands the Tickets provider the API server, so ticket images are broken there
outright — not merely stale.**
`bootstrap.ts:1713-1717` calls `setApiServer(server)` on Design, Setup, TaskViewer, Planning and
Kanban. `ticketsProvider` is missing. `_buildLocalAssetUrl` opens with
`const port = this._apiServer?.getPort?.(); if (!port) { return undefined; }`
(`TicketsPanelProvider.ts:524-526`), so under standalone it always returns `undefined`. The fallback
in `_rewriteLocalImagePaths` is `if (!this._panel) { return match; }` (`:560`) and `_panel` is
undefined headlessly — so the markdown keeps its **relative** `attachments/x.png` path, which the
browser resolves against the panel URL and 404s. `TicketsPanelProvider.setApiServer`'s own docstring
(`:113-135`) describes this exact class of bug for the editor host and ends with "`_apiServer` also
feeds the local-asset port (see `_buildLocalAssetUrl`), so ticket screenshots were losing their
origin for the same reason" — the editor host was fixed; standalone was not.

Note that pushes still reach the browser: `_broadcaster` is the *shared* `headlessBroadcaster`
(`bootstrap.ts:639`) and the sibling `setApiServer` calls hand that same hub the server. Only
`_apiServer` on the Tickets provider itself is unset. That is why the browser Tickets panel looks
alive while every embedded ticket image is a broken icon.

**7. The asset route's allow-list never unions the Tickets provider's roots, so a configured
`ticketSaveLocation` serves 403 in both hosts.**
`_handleDesignAsset` builds its allow-list from exactly two option providers —
`getDesignAssetRoots` and `getPlanningAssetRoots` (`LocalApiServer.ts:966-994`) — and deliberately
ignores the caller-supplied `root` param. `getTicketsAssetRoots` (`TicketsPanelProvider.ts:501`) is
wired into **neither** host: `bootstrap.ts:1664-1665` and `TaskViewerProvider.ts:2381-2384` both pass
only the Design and Planning providers.

This is *narrower* than it first appears, and the narrowing matters.
`PlanningPanelProvider.getPlanningAssetRoots` (`:2339`) already covers
`service.getTicketsFolderPaths()`, `service.getFolderPaths()` and `<root>/.switchboard/tickets` — its
docstring says so explicitly. So the default and the explicitly-configured tickets folders **are**
served today, which is why editor-host ticket images render at all.

The gap is the third root that only `getTicketsAssetRoots` contributes:
`path.join(cfg.ticketSaveLocation, provider)` read from `GlobalIntegrationConfigService`. Its own
in-code comment records why it was added — *"a custom save location was absent from the allow-list
and every asset under it failed the guard."* That fix landed on the **provider's** URL-building guard
and never on the **route's** serving guard. So when `ticketSaveLocation` is set (the exact
configuration defect 5's out-of-workspace fallback exists to support), `_buildLocalAssetUrl` happily
emits a URL and the route then 403s it. No amount of watcher or render-path work can make that image
appear.

`src/test/verb-engine-tickets-headless.test.js:417` looks like it covers this and does not: it
asserts the *shape* of the string `_buildLocalAssetUrl` returns and never fetches it. Same family of
false-green as the watcher test in defect 5.

## Metadata

- **Complexity:** 7
- **Tags:** bugfix, frontend, backend, reliability, ui
- **Project:** Browser Switchboard

> **Superseded:** Complexity 6.
> **Reason:** Scope grew during the improve pass — a sixth defect (standalone `setApiServer`), a
> shared-applier refactor spanning two webview arms, and a corrected asset→ticket resolution that now
> has to filter by content reference rather than by directory. Four files across two hosts, changing
> watcher-filter semantics inside a provider shipped to ~4,000 installs.
> **Replaced with:** Complexity 7 → Send to Lead Coder.

## User Review Required

None. Every decision in this plan is settled below.

## Complexity Audit

### Routine

- Adding a version token to `_buildLocalAssetUrl`. The route already ignores unknown query params
  (`_handleDesignAsset` reads only `path`, from `URL.searchParams`, and dispatches on a
  query-stripped `pathname`), so an extra `&v=` is inert server-side and cannot cause the
  "server stats `image.png?v=123`" 404.
- Applying `message.title` to the selected ticket object in the webview.
- Adding the missing `ticketsProvider.setApiServer(server)` line in `bootstrap.ts` — one line,
  identical in shape to the five lines above it.
- Wiring `getTicketsAssetRoots` into the route options in both hosts — two call sites, each a
  one-line mirror of the `getPlanningAssetRoots` line beside it.
- Copying `_setupNativeFolderWatchFallback` — a proven, in-repo pattern with an existing platform
  guard and an `'error'` listener.

### Complex / Risky

- **Widening the watcher filter past `.md`.** The folder watcher is recursive over the whole tickets
  save location. Admitting every file would fire `handleTicketFileEvent` for temp files, `.DS_Store`,
  editor swap files and git internals. The filter must widen to an explicit image-extension
  allow-list, and asset events must take a *separate* code path that resolves the owning ticket files
  rather than trying to parse the asset's own name against `TICKET_FILE_NAME_RE`.
- **Asset→ticket fan-out.** Tickets are **not** stored one-per-directory.
  `TaskViewerProvider._buildTicketDir` (`:22205`) writes to
  `<ticketSaveLocation>/<provider>/<space>/<folder>/<list>/`, and the attach handler puts assets in
  `<that same dir>/attachments/`. A whole ClickUp list — potentially hundreds of ticket `.md` files —
  shares one `attachments/` directory. Resolving an asset event to "every `.md` in the parent
  directory" would emit hundreds of `ticketFileChanged` pushes per single image write, each
  triggering a `renderMarkdown` in every connected surface. The resolution must be filtered by actual
  content reference.
- **Wiring a live watcher into standalone.** `headlessSeams` at `bootstrap.ts:610` is shared by
  `DesignPanelProvider`, `SetupPanelProvider`, `TicketsPanelProvider` and `TaskViewerProvider`.
  Replacing `watcher` wholesale switches on folder watching for all of them at once. Override
  **only** `watchFolder`, leaving `watchPattern` / `watchFile` as they are — the same scoping
  decision `createHeadlessHostSeams` already made and documented (`hostServices.ts:447-454`).
- **Removing the `hasChanged` early-out.** It exists to avoid re-rendering on no-op writes. Deleting
  it outright would re-render on every touch of every ticket file. Replace it with a wider change
  signature (title + rendered body, where the body now carries the asset version) rather than
  dropping the guard.
- **Double-firing.** If the native `fs.watch` fallback is armed for a folder the VS Code watcher also
  covers, each write fires twice. The existing 300 ms per-file debounce in
  `_ticketsViewWatcherDebounces` absorbs this, but the fallback must still be skipped for
  in-workspace folders (as `DesignPanelProvider` does) so the common case stays single-armed.
- **A source-shape test pins the arm being rewritten.** `src/test/tickets-auto-refresh-on-file-change.test.js`
  asserts against the literal text of both `tickets.js` and `TicketsPanelProvider.ts`, including an
  exact-indentation match (`/\n\s{16}_scheduleSidebarRefreshFromFiles\(\);/`) and a slice of
  `_setupTicketsViewWatcher` bounded by the next `\n    private `. Both files are edited here, so the
  rewrite has to be shaped to keep those assertions true — see Verification Plan.
- **Widening a security allow-list.** Change 8 adds a third root provider to the `/design/asset`
  route. The route is the one place in this plan where a mistake is a file-disclosure bug rather than
  a stale pixel, and `src/test/design-asset-route-traversal.test.js` exists precisely to hold that
  line. The widening must add `path.join(cfg.ticketSaveLocation, provider)` and nothing broader.
- **Dropped-event handling has no in-repo precedent to copy.** Every existing fallback discards the
  `filename === null` FSEvents overflow signal. The rescan branch in Change 4 is the one piece of
  this plan written from research rather than from a working sibling implementation.

## Edge-Case & Dependency Audit

**Race conditions**

- **Asset write vs. `.md` write.** An agent that rewrites both the markdown and its image emits two
  events. They land on different debounce keys (`<mdPath>` vs `asset:<assetPath>`), so both fire;
  the second emit is idempotent (same payload rebuild) and the webview's signature compare absorbs
  the duplicate.
- **Renames.** Retitling re-slugs the filename, arriving as delete(old) + create(new).
  `handleTicketFileDelete` already resolves this via `_findTicketFileById`. Asset-change handling
  must not interfere with that debounce map — key asset events distinctly (`asset:` prefix) so an
  asset write cannot cancel a queued rename resolution for the same path.
- **`existsSync` → `statSync` race on the version token.** `_rewriteLocalImagePaths` guards with
  `if (!fs.existsSync(absPath)) { return match; }`; the file can vanish between that check and the
  `stat`. The `stat` must be `try`-wrapped so the failure degrades to "no version token" rather than
  throwing out of the rewrite and losing the whole image.
- **fs.watch double-fire on macOS.** `fs.watch` reports a single save as two events. The existing
  300 ms debounce absorbs it, which is the same reliance `DesignPanelProvider` documents.

**Security**

- The `&v=` token is a plain integer derived from `mtimeMs`. It is never read server-side —
  `_handleDesignAsset` resolves only `root` and `path`, then realpaths and allow-list-checks the
  target (`LocalApiServer.ts:995-1012`) and rejects any extension outside
  `DESIGN_ASSET_EXTENSIONS`. Adding a query param cannot widen that surface.
- The asset watcher must not become a path-traversal read primitive: it only ever calls
  `readdirSync` on a directory that is already inside a watched tickets folder, and it emits through
  the same `_buildLocalAssetUrl` allow-list that governs the existing render path.

**Side effects**

- **Edit mode.** `renderTicketsLinearTaskDetail` / `renderTicketsClickUpTaskDetail` early-return on
  `ticketsEditMode` (`tickets.js:3267`, `:3372`), and `_refreshSelectedTicketFromFile` guards on it
  (`:2932`). A file-driven refresh must never clobber a textarea the user is typing in. State may be
  updated behind the scenes; `exitTicketsEditMode` already re-reads from file (`:3117`).
- **Scroll position.** Any `innerHTML` rewrite of the detail pane resets scroll. The memoisation at
  `tickets.js:3365` / `:3470` is what keeps that from happening on no-op renders, so the fix must not
  blindly invalidate it — see the Superseded callout in Proposed Change 5.
- **Symlinked tickets folders.** `_buildLocalAssetUrl` realpaths the target and compares against
  realpathed allow-list folders. The `stat` for the version token must run on the same realpathed
  path or it will `ENOENT` on a symlinked tree.
- **Deleted asset.** `_rewriteLocalImagePaths` already returns the original markdown when
  `!fs.existsSync(absPath)`, and the asset watcher should still re-emit on asset *delete* so the pane
  converges on the broken-image state instead of holding a URL to bytes that are gone.
- **Non-image assets.** Only the extensions in `LocalApiServer.DESIGN_ASSET_EXTENSIONS` are servable.
  The watcher's asset allow-list must be exactly that set — watching a `.pdf` produces an event that
  can never change what is rendered.
- **Assets outside `attachments/`.** A hand-authored `![](../shared/logo.png)` is servable (the
  allow-list in `getTicketsAssetRoots` is broader than `attachments/`) but will not be watched. That
  is a deliberate scope boundary: watching every servable path would mean scanning every ticket file
  in every watched folder on every image write anywhere under the save location.
- **Broadcast scope.** `postMessageToWebview` fans out to every connected Tickets surface via
  `BroadcastHub` (`TicketsPanelProvider.ts:194`, and the `_scoped` docstring at `:203` records a
  verified cross-panel bleed). `ticketFileChanged` is currently unscoped. Do **not** change its
  scoping in this plan — every surface watching the same folder genuinely wants the event — but the
  new fields must not carry panel-specific state.

**Dependencies & conflicts**

- **PRD contract 7 (two-layer completion).** The standalone half of this plan is Layer 2 work:
  Layer 1 (`setupTicketsWatcher` host-agnostic, allowlisted, returning in-body, headless-tested at
  `src/test/verb-engine-tickets-headless.test.js:555`) is already done. Defects 5 and 6 are precisely
  the "migrated-but-unreachable" failure the contract names.
- **PRD contract 6 (capability-gating honesty).** Standalone ticket images currently render as broken
  icons — a surface that is reachable but not usable. Defect 6 is the fix, not a gate.
- **PRD orchestration discipline (one agent stream per provider file).** Four of the six changes land
  in `TicketsPanelProvider.ts`. They must be one serialised stream, not parallel edits.
- **Linux.** Recursive `fs.watch` works on Linux under Node 20+ (see Resolved Assumptions #2), so the
  flat-watch fallback in `createStandaloneFolderWatcher` — which does *not* cover the `attachments/`
  subdirectory — is now reached mainly via `inotify` exhaustion (`ENOSPC`/`EMFILE`) on a large tree
  rather than via an unconditional throw. Keep the existing warn-and-skip precedent, and log the
  degradation explicitly rather than silently shipping a half-working watcher.
- **Burst writes.** Under heavy I/O macOS FSEvents coalesces and can drop granularity, delivering
  `filename === null`. An agent rewriting a batch of tickets plus their images is exactly that
  burst. Handled by the rescan branch in Change 4; without it a batch update can leave every pane
  stale with no event to recover from.
- **Migration.** No persisted state changes. `ticketFileChanged` is an in-session postMessage, and
  the asset URL is regenerated on every read — an older webview simply ignores unknown message
  fields, and a `&v=` param is inert to the route. Nothing here is shipped-state that needs
  migrating.
- **`dist/`.** Per project rules, `src/` is the source of truth; the built bundle is not part of the
  dev/test loop and must not be audited here.

## Dependencies

- None. No prior session's output is required.

## Adversarial Synthesis

**Risk summary.** The dominant risk is fan-out: ticket files are stored many-per-directory, so a
naive asset→ticket resolution emits one push per ticket in a whole ClickUp list on every image write.
The second, and the reason this bug survived so long, is **false-green verification** — three
existing assertions pass while the thing they appear to cover is broken: the watcher test pins
`createStandaloneFolderWatcher` inside a bundle documented as NOT WIRED, the asset test pins the
*shape* of a URL the route then 403s, and the return-contract ratchet says nothing about either.
"Tests pass" has never meant "an image refreshes". Mitigations: resolve asset events only to ticket
files that actually reference the changed asset; replace each shape/dead-bundle assertion with one
that exercises the wired path end-to-end; keep the render memo intact so the fix cannot regress
scroll position; and ship the two one-line wirings (`setApiServer`, `getTicketsAssetRoots`) without
which every other change here is invisible. Research (Resolved Assumptions) removed the largest
open question by confirming the `&v=` token is the sole working mechanism, not a redundancy.

## Proposed Changes

### 1. `src/services/TicketsPanelProvider.ts` — version the asset URL

Make the URL a function of the file's content-time so an image swap changes the rendered HTML.

```ts
private _buildLocalAssetUrl(absPath: string): string | undefined {
    // …unchanged: port check, realpath, allow-list guard…
    const root = this._getWorkspaceRoot() || '';
    // Cache-busting version token. Without it the URL is byte-identical after an
    // image is overwritten in place, so every downstream equality check (the
    // ticketFileChanged hasChanged guard, the _lastTickets*DetailContentHtml memo)
    // concludes "nothing changed" and the live <img> node is never recreated.
    // The route ignores unknown query params, so this is inert server-side.
    // stat on realTarget, not absPath — the allow-list already realpathed, and a
    // symlinked tickets tree would ENOENT on the pre-realpath path.
    let version = '';
    try { version = `&v=${Math.floor(fs.statSync(realTarget).mtimeMs)}`; } catch { /* best effort */ }
    return `http://127.0.0.1:${port}/design/asset?root=${encodeURIComponent(root)}&path=${encodeURIComponent(realTarget)}${version}`;
}
```

Apply the same token to the `asWebviewUri` fallback in `_rewriteLocalImagePaths`
(`TicketsPanelProvider.ts:560-562`) as `?v=` — that URI carries no query of its own.

**The token is mandatory, not defence-in-depth.** Web research (2026-08-12) settled this: it is
required for two independent reasons, either of which alone is fatal.

1. **Chromium never issues the request.** Blink's per-Document image memory cache (the WHATWG
   "list of available images") is consulted in the *render* process, before the request reaches the
   network stack. Recreating an `<img>` with a byte-identical `src` hits that cache and
   short-circuits — so the `Cache-Control: no-cache` header, which is evaluated by the network
   stack, is never consulted. This applies identically in a VS Code webview iframe and in the
   browser cockpit, and loopback origins are not exempt. The plan's original reasoning ("the bytes
   are re-fetched whenever a *new* request is made") was right about the mechanism and wrong about
   the trigger: recreating the node is **not** enough. Only a different URL string is.
2. **The guards can't see it either.** Every suppression point on this path — the `hasChanged`
   guard, the `_lastTickets*DetailContentHtml` memo — is a string compare on rendered HTML. Without
   the token those compares are structurally incapable of seeing an image change.

> **Superseded:** Reasoning that treated the token as belt-and-braces over `Cache-Control: no-cache`
> ("the revalidation behaviour is the belt; the token is the braces").
> **Reason:** There is no belt. Research confirmed Blink's memory cache short-circuits in the render
> process, so the header is never reached on an in-place image swap, and the route emits no `ETag`
> or `Last-Modified`, so conditional revalidation could not happen even if the request were issued.
> **Replaced with:** The token is the sole mechanism. If it is dropped, the image never updates —
> regardless of watcher, render or memo behaviour.

Corollary: **do not "optimise" this later by adding `ETag`/`Last-Modified` to the route and removing
the token.** Validators only help once a request is issued; Blink's short-circuit means no request is
issued. Adding them would look like a cleanup and would silently restore the original bug.

Two adjacent hazards research flagged and this codebase is already clear of, recorded so a future
change does not introduce them: the route parses via `new URL(...).searchParams.get('path')` and
dispatches on the query-stripped `pathname` (`LocalApiServer.ts:961`, `:3878`), so the classic
"server stats `image.png?v=123` and 404s" trap does not apply; and `&v=` does not change the origin,
so the existing `img-src http://127.0.0.1:*` CSP allowance is unaffected.

### 2. `src/services/TicketsPanelProvider.ts` — watch ticket assets

> **Superseded:** Resolve an asset event to "every `<provider>_<id>_*.md` in the asset's
> parent-of-`attachments` directory" and replay `_emitTicketFileChanged` for each.
> **Reason:** Tickets are not one-per-directory. `TaskViewerProvider._buildTicketDir` (`:22205`)
> writes every ticket of a list into `<saveLocation>/<provider>/<space>/<folder>/<list>/`, and the
> attach handler (`TicketsPanelProvider.ts:3146`) puts assets in `<that dir>/attachments/`. So the
> "owning directory" of an asset is an entire ClickUp list — the proposed loop would emit one
> `ticketFileChanged` per ticket in that list, each fanning out over `BroadcastHub` to every
> connected surface and each running a `renderMarkdown`, on every single image write.
> **Replaced with:** Resolve by **content reference** — emit only for the `.md` files that actually
> embed the changed asset.

Add an image-extension allow-list and an asset branch in the `watchFolder` callback:

```ts
/** Exactly LocalApiServer.DESIGN_ASSET_EXTENSIONS — anything outside it cannot be served, so
 *  watching it produces an event that can never change what is rendered. */
private static readonly TICKET_ASSET_EXTENSIONS =
    new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif']);

/**
 * An image overwritten in place changes no .md byte, so the ticket that embeds it
 * would never refresh. Map the asset back to the ticket files that actually reference
 * it and replay the normal change path for each — that regenerates displayContent with
 * a fresh &v= token.
 *
 * Reference-filtered, NOT directory-wide: _buildTicketDir groups a whole list into one
 * directory sharing one attachments/ folder, so a directory-wide replay would emit one
 * push per ticket in the list on every image write.
 *
 * Debounce key is prefixed so an asset write can never cancel a queued rename
 * resolution keyed on the same .md path.
 */
private _handleTicketAssetEvent(assetPath: string): void {
    if (!TicketsPanelProvider.TICKET_ASSET_EXTENSIONS.has(path.extname(assetPath).toLowerCase())) { return; }
    const assetDir = path.dirname(assetPath);
    if (path.basename(assetDir).toLowerCase() !== 'attachments') { return; }
    const ticketDir = path.dirname(assetDir);
    const assetName = path.basename(assetPath);
    const key = `asset:${assetPath}`;
    const existing = this._ticketsViewWatcherDebounces.get(key);
    if (existing) { clearTimeout(existing); }
    this._ticketsViewWatcherDebounces.set(key, setTimeout(() => {
        this._ticketsViewWatcherDebounces.delete(key);
        let entries: string[] = [];
        try { entries = fs.readdirSync(ticketDir); } catch { return; }
        for (const entry of entries) {
            if (!TICKET_FILE_NAME_RE.test(entry)) { continue; }
            const full = path.join(ticketDir, entry);
            // Cheap prune: only tickets whose markdown names this asset are affected.
            // The read is not wasted for matches — _emitTicketFileChanged reads anyway.
            let raw = '';
            try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
            if (!raw.includes(assetName)) { continue; }
            this._emitTicketFileChanged(full);
        }
    }, 300));
}
```

Extract the body of the existing debounced read in `handleTicketFileEvent`
(`TicketsPanelProvider.ts:646-658`) into a private `_emitTicketFileChanged(filePath)` so both paths
share one emitter. **Keep `handleTicketFileEvent` itself as the local closure inside
`_setupTicketsViewWatcher`** — `tickets-auto-refresh-on-file-change.test.js:106` slices that method's
body and asserts the rename branch calls `handleTicketFileEvent(survivor)` within it.

`_emitTicketFileChanged` is the same read/strip/H1/rewrite/post sequence that
`case 'readLocalTicketFile'` (`:2274-2286`) performs verbatim; factor the payload build into a
shared `_readTicketFilePayload(filePath, provider, id)` and have both call it, so the `&v=` token and
any future field land on both paths automatically.

Then widen the callback:

```ts
const watcher = this._seams().watcher.watchFolder(folder, (event, filePath) => {
    if (!filePath.endsWith('.md')) {
        // Asset deletes are handled too: _rewriteLocalImagePaths falls back to the raw
        // relative path when the file is gone, so re-emitting converges the pane on the
        // broken-image state rather than leaving a URL to bytes that no longer exist.
        this._handleTicketAssetEvent(filePath);
        return;
    }
    if (event === 'delete') { handleTicketFileDelete(filePath); return; }
    handleTicketFileEvent(filePath);
});
```

### 3. ~~`src/services/TicketsPanelProvider.ts` — carry full file state in the payload~~ — dropped

> **Superseded:** Parse the ticket's frontmatter in `_emitTicketFileChanged` and ship `status`,
> `priority`, `assignees` and `parentId` in the `ticketFileChanged` payload so the webview can
> refresh more than the description body.
> **Reason:** Nothing in the detail pane renders those fields (see the Superseded callout under
> defect 4), so the payload growth buys no visible change. The surfaces that *do* render them are the
> sidebar cards, already refreshed by the existing `_scheduleSidebarRefreshFromFiles()` →
> `listLocalTicketFiles` path, which re-parses the same frontmatter itself
> (`TicketsPanelProvider.ts:2130-2153`). Worse, the change was actively unsafe: it would write
> file-shaped values onto API-shaped objects — frontmatter `priority` parses to
> `{priority,color,orderindex}` and frontmatter `status` is a bare string — into `task.priority` /
> `task.status`, which the sidebar renderers and the priority/assignee filters read. The plan also
> claimed a reusable frontmatter reader exists; it does not. The parsing is inlined twice already
> (`:2130` in the DB-backed lister and `:428` in `_scanLocalTicketFiles`), so "reuse it" would have
> meant writing a third copy.
> **Replaced with:** No payload change. `title` is already in the payload
> (`TicketsPanelProvider.ts:656`); the defect is purely that the webview discards it — fixed in
> Change 5. If a later plan wants live status in the detail pane, that starts with *rendering* status
> there, and extracting the frontmatter reader into one shared helper is the prerequisite.

### 4. `src/services/TicketsPanelProvider.ts` — native `fs.watch` fallback for out-of-workspace folders

Port `DesignPanelProvider._setupNativeFolderWatchFallback` (`DesignPanelProvider.ts:1029`) in shape:
skip when the folder is inside a workspace root, warn-and-skip on Linux, attach an `'error'`
listener, and store handles in a `_ticketsViewNativeWatchers: fs.FSWatcher[]` cleared alongside
`_ticketsViewWatcher` in both `_setupTicketsViewWatcher` and the dispose path at
`TicketsPanelProvider.ts:4099`.

**The callback signature differs and this matters.** `_setupNativeFolderWatchFallback` hands its
consumer `onFile(fullPath)` only — it discards `fs.watch`'s `eventType`, and `fs.watch` reports
`'rename' | 'change'` anyway, which does not map onto the seam's `'create' | 'change' | 'delete'`.
So the tickets adapter must derive the event kind the same way `createStandaloneFolderWatcher`
already does (`hostServices.ts:38-40`) — existence at delivery time decides:

```ts
this._setupNativeFolderWatchFallback(folder, this._ticketsViewNativeWatchers, (filePath) => {
    if (!filePath.endsWith('.md')) { this._handleTicketAssetEvent(filePath); return; }
    if (!fs.existsSync(filePath)) { handleTicketFileDelete(filePath); return; }
    handleTicketFileEvent(filePath);
});
```

Without the existence check every out-of-workspace delete would be read as a change, and
`_emitTicketFileChanged` would silently swallow it in its `catch`, leaving a deleted ticket's card on
screen forever.

**Handle the dropped-events signal.** Research surfaced a case none of the in-repo fallbacks handle:
under burst I/O, macOS FSEvents sets `kFSEventStreamEventFlagKernelDropped` /
`kFSEventStreamEventFlagMustScanSubDirs` and delivers a callback with **`filename === null`**,
meaning "something under here changed, granularity lost". Both `_setupNativeFolderWatchFallback`
(`DesignPanelProvider.ts:1045`, `if (!filename) return;`) and `createStandaloneFolderWatcher`
(`hostServices.ts:36`, `if (!filename) { return; }`) discard it. An agent rewriting a batch of
tickets and their images is exactly the burst that triggers it. For the tickets adapter, treat a null
filename as "rescan this folder": debounce on a `rescan:<folder>` key and replay
`_emitTicketFileChanged` for every ticket `.md` directly in it. Do not change the shared Design
helper's behaviour — pass the null through to the tickets callback and handle it there, so this stays
scoped to the provider this plan owns.

**Linux is a lower-priority target than the plan assumed, but for a different reason.** See the
Resolved Assumptions section: recursive `fs.watch` no longer throws on Linux under Node 20+. The
warn-and-skip guard copied from `DesignPanelProvider` is therefore a conservative no-op on modern
runtimes rather than a necessity. Keep it — matching the sibling fallbacks is worth more than the
coverage it forgoes, and this plan is not the place to re-qualify every native watcher in the repo —
but write the comment to say *why* it is kept (parity with three existing fallbacks pending a
repo-wide re-qualification), not the now-stale claim that the call throws.

### 5. `src/webview/tickets.js` — one shared applier for both file-driven arms

> **Superseded:** Rewrite the `'ticketFileChanged'` arm inline with a `_fileSig` JSON signature over
> `[rendered, title, status, priority, assignees]`, spread the new fields onto `task` / `issue`, and
> force `_lastTicketsDetailContentHtml = ''` / `_lastTicketsClickUpDetailContentHtml = ''` to bust the
> render memo.
> **Reason:** Three problems. (a) The signature covers fields nothing renders (see Change 3), so it
> fires re-renders that change no pixel. (b) Busting the memo is redundant with the `&v=` token — an
> asset change already alters `contentHtml`, so the memo invalidates itself; the only cases where the
> forced bust does anything are exactly the cases where `contentHtml` is *identical*, i.e. it
> rewrites `innerHTML` with the same string and resets the user's scroll position for nothing.
> (c) Patching fields inline in one arm leaves the identical stale-title bug in `localTicketFileRead`
> (`tickets.js:7682`, `task: existing?.task || {…}`), which is the arm that runs on exit-from-edit —
> so "edit the title, exit edit mode" would still show the old heading.
> **Replaced with:** A single `_applyTicketFilePayloadToSelected(message)` helper called by **both**
> arms, comparing only what is actually rendered, and leaving the memo alone.

```js
// Both 'ticketFileChanged' and 'localTicketFileRead' deliver the same payload shape
// ({ provider, id, title, content, rawContent }) — the provider builds them from one
// helper. Applying them through one function is what stops the two arms from drifting:
// the title bug fixed in one used to survive in the other.
// Returns true when something the detail pane actually renders changed.
function _applyTicketFilePayloadToSelected(message) {
    if (ticketsEditMode) return false;          // never clobber a live textarea
    const isClickUp = message.provider === 'clickup' && selectedClickUpIssue?.task?.id === message.id;
    const isLinear  = message.provider === 'linear'  && selectedLinearIssue?.issue?.id === message.id;
    if (!isClickUp && !isLinear) return false;

    const previewMarkdown = (message.content || '').replace(/^#[^\n]*\n?/, '').trim();
    const editMarkdown = (message.rawContent || message.content || '').replace(/^#[^\n]*\n?/, '').trim();
    const rendered = renderMarkdown(previewMarkdown);
    const prev = isClickUp ? selectedClickUpIssue : selectedLinearIssue;
    const prevTitle = isClickUp ? prev?.task?.title : prev?.issue?.title;
    const nextTitle = message.title || prevTitle;

    // Compare exactly what the renderers put in contentHtml: the <h1> and the body.
    // An image swap shows up here because the &v= token is inside `rendered`.
    if (rendered === prev?.renderedDescriptionHtml && nextTitle === prevTitle) return false;

    if (isClickUp) {
        selectedClickUpIssue = {
            ...prev,
            task: { ...prev.task, title: nextTitle, name: nextTitle },
            renderedDescriptionHtml: rendered,
            descriptionMarkdown: editMarkdown,
            localDescription: true
        };
        clickUpTaskDetailCache.set(message.id, selectedClickUpIssue);
    } else {
        selectedLinearIssue = {
            ...prev,
            issue: { ...prev.issue, title: nextTitle },
            renderedDescriptionHtml: rendered,
            descriptionMarkdown: editMarkdown,
            localDescription: true
        };
        linearIssueDetailCache.set(message.id, selectedLinearIssue);
    }
    return true;
}
```

`case 'ticketFileChanged'` then becomes: call the helper for the selected ticket and
`renderTicketsTab()` when it returns `true`; leave the existing non-selected cache-update block and
the trailing `_scheduleSidebarRefreshFromFiles()` **byte-for-byte unchanged, at their current
indentation** (the regression test matches `_scheduleSidebarRefreshFromFiles();` at exactly 16
spaces). `case 'localTicketFileRead'` keeps its "no local file" early-out and its
`clearTicketsStatus()`, but routes its selected-ticket construction through the same helper, falling
back to the current from-scratch build only when there is no cache entry yet.

No memo invalidation. The `&v=` token makes `contentHtml` differ whenever the image differs, so
`_lastTicketsDetailContentHtml !== contentHtml` (`tickets.js:3365`) is true exactly when a DOM rewrite
is warranted — which is also what preserves scroll position on no-op events.

### 6. `src/standalone/bootstrap.ts` — hand Tickets the API server

One line, alongside the five that already exist at `bootstrap.ts:1713-1717`:

```ts
designProvider.setApiServer(server);
setupProvider.setApiServer(server);
taskViewerProvider.setApiServer(server);
planningProvider.setApiServer(server);
kanbanProvider.setApiServer(server);
// Tickets was missing. Without it _apiServer stays undefined, _buildLocalAssetUrl
// returns undefined for want of a port, and _rewriteLocalImagePaths falls through to
// `if (!this._panel) return match` — leaving relative attachments/ paths that 404 in a
// browser tab. Every ticket image in the browser cockpit is a broken icon today.
ticketsProvider.setApiServer(server);
```

This is the highest-value single line in the plan: without it, changes 1, 2 and 5 have no visible
effect in standalone at all, because there is no image URL to version in the first place.

### 7. `src/standalone/bootstrap.ts` — give standalone a live folder watcher

`createVscodeHostSeams` bottoms out in the shim's no-op `createFileSystemWatcher`, so the browser
cockpit receives no `ticketFileChanged` at all. Override just `watchFolder` on the bundle:

```ts
const headlessSeams: HostSeams = createVscodeHostSeams(workspaceRoot, secretStorage as any);
// vscodeShim.createFileSystemWatcher is a no-op, so VscodeHostFileWatcher.watchFolder
// attaches nothing under standalone — the Tickets display watcher arms cleanly and then
// never fires. Swap in the real fs.watch implementation. watchPattern/watchFile stay
// stubbed: they have no standalone consumer and turning them on would change unrelated
// subsystems without a test holding the line (same scoping as createHeadlessHostSeams).
headlessSeams.watcher = {
    ...headlessSeams.watcher,
    watchFolder: createStandaloneFolderWatcher
};
```

Export `createStandaloneFolderWatcher` from `src/standalone/hostServices.ts` (currently
module-private) and import it here. Leave `createHeadlessHostSeams` untouched — it stays unwired, and
its NOT WIRED docstring stays accurate.

**Log the flat-watch degradation.** `createStandaloneFolderWatcher` falls back to a flat,
non-recursive `fs.watch` when the recursive call throws (`hostServices.ts:44-52`), and a flat watch
does not see `attachments/`. Research says that branch is now rare — Node 20+ supports recursive
watching on Linux, and VS Code ships Node 20/22 — but it remains reachable on older runtimes and on
`inotify` resource exhaustion (`ENOSPC` / `EMFILE`), which is the *likely* trigger on a large tree.
Add a `console.warn` on that branch naming the consequence ("flat watch — asset changes under
`attachments/` will not refresh"), so the degradation is visible rather than silent.

### 8. `src/services/LocalApiServer.ts` + both hosts — union the Tickets asset roots into the route

Defect 7. `getTicketsAssetRoots` is public on the provider and consulted by `_buildLocalAssetUrl`,
but no host passes it to `LocalApiServer`, so the route's allow-list is Design ∪ Planning only. Add a
third option and union it exactly like the other two.

In `LocalApiServer`, accept `getTicketsAssetRoots?: (root: string) => string[]` alongside the
existing two, include it in the `folders` union inside `_handleDesignAsset` (`:986-990`), and extend
the "no allow-list provider wired at all" 503 guard to consider all three.

Then wire it in **both** hosts, mirroring the lines already there:

```ts
// bootstrap.ts, beside :1664-1665
getTicketsAssetRoots: (wsRoot: string) => ticketsProvider.getTicketsAssetRoots(wsRoot),

// TaskViewerProvider.ts, beside :2381-2384
getTicketsAssetRoots: (wsRoot: string) =>
    (this._ticketsPanelProvider as any)?.getTicketsAssetRoots?.(wsRoot) ?? [],
```

**Security note — this widens a deliberately tight allow-list, so keep the widening narrow.**
`getTicketsAssetRoots` adds `path.join(cfg.ticketSaveLocation, provider)`, i.e. a *global,
user-configured* directory that can sit anywhere on disk. That is the same trust level the route
already extends to Design/HTML/Claude/Images folders and to `getTicketsFolderPaths()`, all equally
user-configured, and every path is still realpath'd, prefix-checked and extension-gated before a byte
is served (`LocalApiServer.ts:999-1012`). What must **not** happen is broadening to
`cfg.ticketSaveLocation` itself without the `provider` segment, or to the parent of a configured
folder. `src/test/design-asset-route-traversal.test.js` is the guard on this — extend it with a
tickets case rather than adding a parallel test file.

## Verification Plan

Compilation and test execution are out of scope for this planning pass; the steps below are for the
implementing agent.

**Editor host — images**
1. Open a ticket whose description embeds `![](attachments/x.png)`.
2. From a terminal, overwrite `attachments/x.png` with different image bytes.
3. The rendered image updates within ~1s with no interaction. Confirm in the webview dev-tools
   Network tab that a fresh `GET /design/asset?…&v=<new-mtime>` fired, and that the `<img>` `src`
   carries a different `v=` than before.
4. In a directory holding 20+ ticket `.md` files that share one `attachments/`, repeat step 2 and
   count `ticketFileChanged` pushes. Exactly one ticket — the one embedding that filename — must
   emit. This is the fan-out guard from Change 2.

**Editor host — title**
5. With a ticket open, edit its `.md` H1 to a new title. The detail `<h1>` updates in place, and the
   sidebar card title updates in the same pass.
6. Enter edit mode, change the H1 in the textarea, save and exit. The heading updates — this is the
   `localTicketFileRead` half of the shared applier, which was broken independently.

**Editor host — no regressions**
7. `touch` a ticket file without changing content. No re-render occurs, and the detail pane's scroll
   position is unchanged after scrolling halfway down a long ticket.
8. Edit only the frontmatter `status:` value. The **sidebar card** status updates via the existing
   `listLocalTicketFiles` reload. The detail pane does not change, because it does not render status
   — this is expected, not a failure.
9. Rename a ticket file (delete + create). No card disappears, no blank detail pane — confirms the
   `asset:`-prefixed debounce key did not collide with the rename resolution.
10. Enter edit mode, type into the description, and have an agent write the same file. The textarea
    content is not clobbered. Exit edit mode; the pane shows the file's current state.
11. Drop a `.DS_Store` and a `.pdf` into the tickets folder. Neither produces a `ticketFileChanged`.
12. Delete an embedded image. The pane converges on a broken-image placeholder rather than holding a
    stale render.

13. Batch-write: script an overwrite of 20 ticket `.md` files and 20 images in one burst. The pane
    for the selected ticket ends in the correct final state. If the extension log shows an FSEvents
    null-filename callback, confirm the rescan branch fired rather than the event being dropped
    (Change 4).

**Out-of-workspace save location**
14. Set `ticketSaveLocation` (Setup) to a folder outside every workspace root, then open a ticket
    stored there whose markdown embeds an image. **The image must render.** Before Change 8 this is a
    403 from `/design/asset` — check the Network tab, not just the pixels, so a cached render cannot
    mask it.
15. Repeat steps 2 and 5 against that folder. Both refresh. Confirm the extension log shows the
    native fallback armed for that folder and NOT for `.switchboard/tickets` (in-workspace →
    skipped, no double-fire).
16. Delete a ticket file in that out-of-workspace folder. The card disappears — confirms the
    existence-check event derivation in Change 4, which the ported helper does not supply on its own.
17. Negative control for Change 8: request `/design/asset?path=<a file just OUTSIDE the configured
    ticketSaveLocation>` directly with `curl`. It must still 403.

**Standalone / browser cockpit**
18. Run the standalone server, open the Tickets panel in a browser tab, select a ticket with an
    embedded image. **Before any other check:** the image renders at all (defect 6). Its `src` is an
    absolute `http://127.0.0.1:<port>/design/asset?…`, not a relative `attachments/…`.
19. Edit the ticket `.md` from a terminal → the detail pane updates live over WS.
20. Overwrite the embedded image → the image updates live, and the Network tab shows a new request
    with a changed `v=`. Per Resolved Assumptions #1 this cannot work without the token, so a pass
    here with an unchanged `v=` means the image is coincidentally cached, not that the fix works.
21. Confirm the same events reach a second open browser tab (broadcast fan-out intact).

### Automated Tests

22. Unit-test `_handleTicketAssetEvent`: an asset under `<dir>/attachments/` resolves **only** to the
    `<provider>_<id>_*.md` files in `<dir>` whose body references the asset's basename; sibling
    tickets in the same directory that do not reference it resolve to none; an asset outside an
    `attachments/` dir resolves to none; a non-image extension resolves to none.
23. Unit-test `_buildLocalAssetUrl`: two calls straddling a content change with different mtimes
    produce different URLs; the allow-list denial path is unchanged; a `stat` failure degrades to a
    URL without `&v=` rather than throwing.
24. Unit-test `_applyTicketFilePayloadToSelected`: a title-only change returns `true` and updates
    `task.title` / `issue.title`; a byte-identical payload returns `false`; `ticketsEditMode`
    short-circuits to `false` without mutating state.
25. **Extend `src/test/tickets-auto-refresh-on-file-change.test.js` to pin the wiring, not the dead
    bundle.** Its current standalone assertions read `hostServices.ts` and prove
    `createStandaloneFolderWatcher` is real — but that function lives in `createHeadlessHostSeams`,
    which the same repo documents as NOT WIRED. The test has therefore been green for the entire
    period in which the browser cockpit received zero watcher events. Add assertions against
    `src/standalone/bootstrap.ts` that it (a) overrides `headlessSeams.watcher.watchFolder` with
    `createStandaloneFolderWatcher`, and (b) calls `ticketsProvider.setApiServer(server)`.
26. **Extend `src/test/design-asset-route-traversal.test.js` with a tickets case** — a real file
    under a configured `ticketSaveLocation` is served 200 once `getTicketsAssetRoots` is wired, and a
    sibling file just outside it still 403s. This must be an end-to-end route test, not a
    URL-shape assertion: `verb-engine-tickets-headless.test.js:417` already asserts the shape and was
    green throughout the period defect 7 was live.
27. Re-run the existing tickets suite (`src/test/tickets-*.test.js`, `verb-engine-tickets-headless.test.js`).
    Note the five regression tests already red at HEAD — stash-verify before attributing any failure
    to this change. Pay particular attention to
    `tickets-auto-refresh-on-file-change.test.js`, which asserts on the literal source text of both
    edited files: the exact-16-space `_scheduleSidebarRefreshFromFiles();` match, and the
    `_setupTicketsViewWatcher` body slice bounded by the next `\n    private ` (so any new private
    method must be declared *after* that method, not spliced inside it).

## Resolved Assumptions

All four uncertainties raised during planning were closed by web research on 2026-08-12. **This
section is authoritative — do not re-open these questions or re-run research on them.** No open
uncertainties remain; there is nothing outstanding to confirm before implementation.

1. **`Cache-Control: no-cache` alone does NOT force a refetch when an `<img>` is recreated with an
   unchanged `src`. The `&v=` token is mandatory.** Blink's per-Document image memory cache (the
   WHATWG "list of available images") is consulted inside the render process and short-circuits
   before the request reaches the network stack, so the header is never evaluated. Applies
   identically in Chromium, Electron BrowserViews and VS Code webview iframes; loopback origins are
   not exempt. The route also emits no `ETag`/`Last-Modified`, so conditional revalidation could not
   occur even if a request were issued. → Change 1 is load-bearing, not optional. *Sources: WHATWG
   HTML §4.8.4; RFC 9111 §5.2.2.4; Chromium `ResourceFetcher`/`MemoryCache`; Chromium issue
   41200696.*

2. **Recursive `fs.watch` no longer throws on Linux.** Node 20+ supports `{ recursive: true }` on
   Linux via managed `inotify` watch descriptors, and stable VS Code (1.90+, Electron 30+) runs
   extensions on Node 20/22. The real Linux failure mode is not `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`
   but resource exhaustion (`fs.inotify.max_user_watches` → `ENOSPC`/`EMFILE`) and missed events when
   files are created in a subdirectory faster than a watch can be attached to it. → The warn-and-skip
   guard in Change 4 is kept for parity with three sibling fallbacks, but its comment must state that
   reason rather than the stale "throws on Linux" claim; the flat-watch warning in Change 7 must name
   exhaustion as the likely trigger.

3. **macOS FSEvents does cover subdirectories created after the watch was armed.** FSEvents streams
   the directory hierarchy rather than attaching per-directory descriptors, so files written into a
   newly created `attachments/` emit events with no re-registration. → No extra arming logic is
   needed for a late-created `attachments/` on macOS. The same research surfaced the corollary this
   plan now handles in Change 4: under burst load FSEvents sets
   `kFSEventStreamEventFlagKernelDropped`/`MustScanSubDirs` and delivers `filename === null`, which
   every in-repo fallback currently discards.

4. **`createFileSystemWatcher` with a `RelativePattern` rooted at an absolute out-of-workspace `Uri`
   is officially supported (VS Code 1.64+), recurses on `**/*`, and fires for binary files** — it
   operates at the OS event layer and is content-type agnostic. → The native fallback in Change 4 is
   therefore **defence-in-depth against documented flakiness** (microsoft/vscode #162498, cited by
   the `DesignPanelProvider` docstring), not a correctness requirement. It stays: three sibling
   subsystems carry it and diverging here would be its own bug. But if it ever needs to be cut for
   complexity, this is the change with the weakest independent justification — cut it before cutting
   anything else.

---

## Completion Report

Implemented all seven changes: added `&v=` mtime tokens to `_buildLocalAssetUrl` and the webview fallback, wired asset watching with `_handleTicketAssetEvent`, added a native `fs.watch` fallback plus rescan branch, added a shared `_applyTicketFilePayloadToSelected` applier in `tickets.js`, wired `ticketsProvider.setApiServer(server)` and `getTicketsAssetRoots` in both hosts, and exported `createStandaloneFolderWatcher` with a flat-watch warning. Files changed: `src/services/TicketsPanelProvider.ts`, `src/webview/tickets.js`, `src/standalone/bootstrap.ts`, `src/standalone/hostServices.ts`, `src/services/LocalApiServer.ts`, and `src/services/TaskViewerProvider.ts`. No compilation or tests were run per the plan instructions; existing source-shape tests should remain satisfied by the retained method order and indentation. No issues encountered during the edit pass.

**Recommendation: Send to Lead Coder** (complexity 7).

---

## Review Findings

Reviewer pass 2026-08-12. All seven changes are present and correct in
`TicketsPanelProvider.ts`, `bootstrap.ts`, `hostServices.ts`, `LocalApiServer.ts` and
`TaskViewerProvider.ts`. One CRITICAL regression fixed: consolidating `localTicketFileRead`
onto the patch-only shared applier deleted the from-scratch build, so a ticket's *first*
selection (no detail-cache entry → the click handler leaves the previous selection in place)
applied nothing and the pane then showed the **remote** description — discarding unpushed
local edits and local image URLs; the build is restored behind an `_isSelectedTicketPayload`
guard, with the file H1 now beating any cached title. Three MAJOR gaps closed: the
`stripImportedSubtasksBlock` ratchet (broken 2→1 by the shared-builder refactor) was repaired
by pinning the `_readTicketFilePayload` choke point instead of just lowering the number, and
the plan's items 22–26 were written — real invoking tests for `_buildLocalAssetUrl`'s version
token and `_handleTicketAssetEvent`'s reference-filtered fan-out, plus end-to-end
`/design/asset` cases for a configured `ticketSaveLocation` and bootstrap wiring assertions
replacing the dead-bundle false-greens. Files changed by this review: `src/webview/tickets.js`,
`src/test/tickets-subtask-embedding.test.js`, `src/test/tickets-auto-refresh-on-file-change.test.js`,
`src/test/design-asset-route-traversal.test.js`, `src/test/verb-engine-tickets-headless.test.js`.
Validation: 11 tickets/asset contract gates PASS (verb-engine-tickets 49/49, design-asset 16/16),
plus `catalog`/`parity`/`push-routing`/`standalone-parity`/`verb-returns`/`standalone-fork`
ratchets green and eslint 0 errors. Remaining risks, both owned by **other** concurrent cards
in this working tree, not by this plan: `tickets-subtask-embedding` still fails at
`_relocalizeInlineImages` because the uncommitted `TaskViewerProvider` attachment work put a TS
annotation (`const repairs: Record<string, string>`) inside a body that test evals via
`new Function`; `compile-tests` is red on four errors in `standingOrders.ts` / `LocalApiServer.ts:2261`
/ `TaskViewerProvider.ts:22641,24669`; and `mirror:check` is red on unregenerated `.claude/skills`
mirrors. None touch this plan's files.
