# Fix: HTML Previews dropdown shows an empty sidebar in design.html

## Goal

When the user opens the **Previews** tab in `design.html` and switches the
source dropdown to **HTML Previews**, the left sidebar (`#tree-pane-html`)
renders nothing — no file list, no folder headers, and no empty-state message.
It should list the configured HTML folders and the `.html`/`.htm` files inside
them (or show a clear empty-state when none are configured).

### Problem analysis & background

The Previews tab collapses three previously-separate surfaces behind a single
`<select id="previews-source-select">` dropdown (`Stitch HTML` / `HTML Previews`
/ `Images`). Each surface is a `.previews-subpanel`; only the selected one has
`.active`. The HTML Previews subpanel is `#html-preview-content` containing the
sidebar `#tree-pane-html` and the iframe preview `#html-preview-wrapper`.

The intended render flow on dropdown switch is:

1. `design.js` `selectPreviewsSource('html-preview')` toggles
   `.previews-subpanel.active` onto `#html-preview-content`, posts
   `activeTabChanged { tab: 'html-preview' }`, then posts
   `refreshDocsForTab { tab: 'html-preview' }`
   (`src/webview/design.js` ~L177-199).
2. `DesignPanelProvider._handleMessage` routes `refreshDocsForTab` through a
   `tabSenders` map and calls `_sendHtmlDocsReady()`
   (`src/services/DesignPanelProvider.ts` ~L3900-3920).
3. `_sendHtmlDocsReady()` walks every workspace root via
   `LocalFolderService.listHtmlFiles()`, builds tree nodes with
   `_mapLocalFilesToTreeNodes`, and `postMessage({ type: 'htmlDocsReady', ... })`
   (`src/services/DesignPanelProvider.ts` ~L1213-1264).
4. The webview `case 'htmlDocsReady'` stores `state._lastHtmlDocsMsg`,
   populates the `html-workspace-filter` dropdown, filters nodes by the active
   workspace root, and calls `renderHtmlDocs(...)`
   (`src/webview/design.js` ~L3255-3268).
5. `renderHtmlDocs` clears `#tree-pane-html`, appends a toggle row + Manage
   Folders button + a `.source-doc-list`, filters `kind === 'document'` nodes to
   `.html`/`.htm`, and delegates to `renderFolderGroupedDocs`
   (`src/webview/design.js` ~L997-1068).

### The load-bearing observation the original analysis missed

`#tree-pane-html` is **not empty in the static markup**. `design.html:3850-3855`
ships it pre-populated:

```html
<div id="tree-pane-html">
    <div class="sidebar-toggle-row">
        <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
    </div>
    <div class="empty-state">Configure a folder to browse HTML files</div>
</div>
```

The **only** code that removes that content is `renderHtmlDocs`'s
`treePaneHtml.innerHTML = ''` (`design.js:1002`). Therefore a *literally blank*
pane — no "Configure a folder to browse HTML files" text — is **proof that
`renderHtmlDocs` ran**. A never-arriving `htmlDocsReady` would leave the static
empty-state visible, which is not the reported symptom.

This gives a free, zero-instrumentation triage discriminator, because the
rendered toggle row carries a **Manage Folders** button (`design.js:1007-1012`)
that the static markup does **not**:

| What the sidebar shows | What it proves |
|---|---|
| "Configure a folder to browse HTML files" (+ `«` only, no Manage Folders) | `renderHtmlDocs` **never ran** — round-trip gap |
| Manage Folders + `«`, nothing below | `renderHtmlDocs` ran, `.source-doc-list` got **nothing appended** → cause (B) or (D) |
| Manage Folders + `«` + "No HTML preview files found." / "No matching…" | cause (C) — an accurate empty-state, folders unconfigured or search stale |
| 40px-wide strip with only `«`/`»` | cause (E) — the row is `.collapsed`, contents `display:none !important` |

Establish which of these four the user is actually looking at **before** writing
any code. It costs one screenshot and eliminates two of the four causes.

### Root cause (to confirm at runtime)

Static inspection of every link in the chain is **correct**: the dropdown
listener is attached, the message names match, `kind` is set to `'document'`
for files, and `name` preserves the `.html` extension so the extension filter
passes. That means the symptom is a **runtime regression** where one of the
following holds.

> **Superseded:** *(A) `htmlDocsReady` never arrives on dropdown switch … the most
> likely sub-cause is that `refreshDocsForTab` is posted but the reply push is
> dropped/routed to the wrong seat after the recent per-client reply-addressing /
> seat work (commits `c332638`, `940fccd`, `46d9e20`), OR the `activeTabChanged` +
> `refreshDocsForTab` pair races with a seat preview-clear that wipes the tree.*
>
> **Reason:** Refuted by reading the transport, both sub-causes:
> 1. **Seat addressing cannot drop this push.** `_sendHtmlDocsReady` posts an
>    **untagged** payload (`DesignPanelProvider.ts:1243-1251` — no `originatorId`
>    field). The webview gate is `if (msg && msg.originatorId && msg.originatorId
>    !== clientOriginatorId) return;` (`design.js:3069`), which only drops messages
>    that *carry* a mismatching `originatorId`; its own comment (`design.js:3067-3068`)
>    states "Untagged messages (folder listings, iframe-sourced events, legacy hosts)
>    always pass." In the browser host the same payload also arrives a second way:
>    `transport.js:315-319` re-dispatches the `refreshDocsForTab` **HTTP response
>    body** as a `MessageEvent`, and that arm returns `{ success: true, ...payload }`
>    with `type: 'htmlDocsReady'` (`DesignPanelProvider.ts:3919`). There are two
>    independent delivery paths in the browser and one unfiltered path in the editor.
> 2. **`activeTabChanged` clears no tree.** The arm
>    (`DesignPanelProvider.ts:2577-2593`) only nulls **server-side** seat preview
>    refs (`seat.htmlPreview`, `seat.claudePreview`, …) and calls `_reconcilePoll()`.
>    It posts nothing to the webview and touches no DOM. There is no "seat
>    preview-clear that wipes the tree" anywhere in the design panel: the only wiper
>    of `#tree-pane-html` is `renderHtmlDocs` itself.
>
> **Replaced with:** Cause (A) is retired as a hypothesis and change #3 (threading
> `originatorId`) is retired with it — see the Superseded callout in Proposed
> Changes. A round-trip gap remains *observable* (it is the first row of the triage
> table above), but if it occurs the sidebar keeps its static "Configure a folder to
> browse HTML files" text, which contradicts the reported symptom. Ranked cause list
> is now (D) > (B) > (E) > (C).

- **(B) `renderHtmlDocs` throws mid-render** after
  `treePaneHtml.innerHTML = ''` (L1002), leaving the pane blank with no
  empty-state. A throw in `getCurrentFolderPaths` / `renderFolderGroupedDocs` /
  `buildAccordionFolderHeader` when `state.htmlFolderPathsByRoot` is in an
  unexpected shape would do this — and would only affect the HTML tab if the
  design/images tabs happen to have well-formed state. Note the throw must land
  **after** `design.js:1020` (toggle row appended) for Manage Folders to be
  visible, and after `:1025` for the empty `.source-doc-list` to exist.
- **(C) No HTML folders are configured** for any root, so `listHtmlFiles()`
  returns `[]` and `folderPaths` is `[]`. In that case `renderHtmlDocs` shows
  "No HTML preview files found." — text, not a blank pane — so this is only
  the cause if the user is misreporting the empty-state text as "empty".
  Still worth surfacing a clearer call-to-action (Manage Folders) in that
  empty-state.
- **(D) NEW — `renderFolderGroupedDocs` completes without appending anything.**
  This is the highest-ranked cause because it produces *exactly* the reported
  symptom with **no throw and no empty-state**, and no existing guard catches it.
  In the non-search branch (`design.js:840-877`) every appended node is keyed on
  `d.metadata?.sourceFolder`:

  ```js
  docNodes.forEach(d => {
      const sf = d.metadata?.sourceFolder;
      if (sf) { … docsByFolder.set(sf, …) }   // ← no `else`: silently dropped
  });
  folderPathsList.forEach(fp => { … });        // ← nothing to iterate if folderPaths is []
  ```

  `metadata.sourceFolder` is **conditionally** present —
  `DesignPanelProvider.ts:998` spreads it only `...(f.sourceFolder ? … : {})`. So a
  listing whose files lack `sourceFolder` (or whose `sourceFolder` values are
  present while `folderPaths` is empty, or vice-versa) yields: `docsByFolder`
  empty → `folderPathsList` empty → zero `appendChild` calls → blank
  `.source-doc-list`. Neither guard fires: `:1027` needs **both** `nodes` and
  `folderPaths` empty, and `:1044` needs `docNodes.length === 0`. A non-empty
  `docNodes` that groups to nothing falls straight through both.
- **(E) NEW — the row is collapsed, not empty.** `state.htmlPreviewCollapsed` is
  restored from persisted webview state (`design.js:79`) and re-applied to the
  `.content-row` on every view-state restore (`design.js:5272` and `:5391`).
  When set, `design.html:339-347` applies
  `#tree-pane-html > *:not(.sidebar-toggle-row) { display: none !important }`
  and `:321-323` shrinks the pane to `flex: 0 0 40px`. A stale persisted `true`
  therefore hides the entire list — including every empty-state — leaving a 40px
  strip that reads as "empty sidebar". Cheap to rule out (the `»` glyph and the
  40px width are both visible), and it needs no code fix if confirmed.

The fix must distinguish (B) vs (C) vs (D) vs (E) before patching, because each
has a different fix and guessing produces a symptom-suppressing patch that
breaks the other paths. **However** — unlike the original framing, the fix is no
longer *blocked* on that classification: change #1 below makes a blank pane
structurally impossible for **all** of (B), (C) and (D) at once, and reports
which one it was in the pane itself.

### Host matrix (PRD contract #1 / #6)

`renderHtmlDocs` is shared byte-identically between the VS Code webview and the
browser cockpit (`headlessPanelHtml.ts` serves the same `design.html`), but the
**transport differs**, so the bug must be reproduced on both hosts:

- **Editor:** provider `postMessage` → webview `message` event (one delivery).
- **Browser:** `transport.js` posts the verb over HTTP; the response body is
  re-dispatched as a `MessageEvent` (`transport.js:315-319`) **and** the
  provider's own `this.postMessage(payload)` fans out over the WS hub
  (`transport.js:194-200`). `refreshDocsForTab` therefore renders the HTML tree
  **twice** per switch in the browser. This is harmless today (each render
  starts with `innerHTML = ''`, so it is idempotent) but it is a hard constraint
  on the fix: **any change to `renderHtmlDocs` must stay idempotent** — no
  append-without-clear, no counter that accumulates across calls.

## Metadata

**Complexity:** 4
**Tags:** frontend, bugfix, ui
**Project:** Browser Switchboard

## User Review Required

1. **Which host and which sidebar state is the user actually seeing?** Answer
   the triage table in the Goal section first (one screenshot). Default
   assumption if unanswered: **browser cockpit, "Manage Folders visible, nothing
   below"** → cause (D). Change #1 is safe and correct under every answer, so
   implementation is not blocked on this — but the *closing* verification is.
2. **Should the diagnostic empty-state ship to users, or be dev-only?** Default:
   **ship it.** A pane that says "3 HTML files found but no folder grouping
   matched — click Manage Folders" is strictly better UX than a blank pane, and
   it is the mechanism that stops this class of bug being silent again.
   Alternative: gate the diagnostic detail behind a `console.warn` and show only
   the generic empty-state.
3. **Keep the `console.log` instrumentation after the fix, or strip it?**
   Default: **keep two lines** (`htmlDocsReady` receipt with counts, and the
   render-invariant warning) and drop the rest. The invariant makes the logs
   optional rather than load-bearing.

## Complexity Audit

### Routine

- Adding `console.log` instrumentation at the boundary points (dropdown change,
  `htmlDocsReady` receipt, `renderHtmlDocs` entry/exit).
- Tightening the empty-state copy / adding a Manage Folders link.
- Wrapping the `renderHtmlDocs` body in `try/catch` — the pane already has a
  single owner and a single wipe point, so the guard has no cross-tab reach.
- The post-render `childElementCount` invariant: ~6 lines, one function, no
  shared code touched.

### Complex / Risky

- **Ruling out cause (E) before patching.** A collapsed row needs *no* code fix;
  shipping a render change to "fix" a persisted-state problem would leave the
  real defect in place and add dead code.
- **Anything touching `renderFolderGroupedDocs` / `buildAccordionFolderHeader`**
  (`design.js:800-879`, `:673+`): shared by the design, images, tickets and
  stitch-html trees. The chosen fix deliberately keeps the invariant **inside**
  `renderHtmlDocs` (caller side) so these shared functions stay byte-identical.
  If a later step *must* change them, every consuming tree needs re-verification.
- **Idempotency under the browser's double delivery** (see Host matrix). A fix
  that appends rather than replaces will double every folder header in the
  browser and look correct in the editor.
- **Multi-root file dedup** (`DesignPanelProvider.ts:1221-1237`): the fix must
  not paper over the dedup asymmetry described in the Edge-Case audit by
  rendering a plausible-looking partial list.

No schema migrations, no auth, no data loss risk. Pure UI bug.

## Edge-Case & Dependency Audit

### Race Conditions

- **Browser double-render.** `refreshDocsForTab` resolves through the HTTP body
  *and* the WS fan-out, in unspecified order. Two `renderHtmlDocs` calls with
  the same payload interleave with the user's own clicks; the second wipe can
  drop an accordion the user just expanded. Pre-existing, in scope only insofar
  as the fix must not worsen it.
- **`_scheduleHtmlDocsReady` vs `_sendHtmlDocsReady`.** The debounced watcher
  path (`DesignPanelProvider.ts:1196-1204`) is cancelled by an explicit send
  (`:1214-1217`), but a folder-watcher burst arriving *after* the explicit send
  re-renders the tree 300ms later. If the user switched away in that window, the
  render lands on a hidden pane — harmless, but it means "the pane was correct
  once" is not evidence the bug is fixed.
- **`activeTabChanged` then `refreshDocsForTab`** are posted back-to-back
  (`design.js:187,196`) and, in the browser, become two independent HTTP posts
  with no ordering guarantee. Verified harmless: the `activeTabChanged` arm
  mutates only server-side seat state and returns.

### Security

- No new input surface. The diagnostic empty-state must **not** interpolate raw
  file paths into `innerHTML` — folder paths are user/filesystem-supplied and
  the existing empty-states are static strings. Build the diagnostic with
  `textContent` (or interpolate only integer counts) to keep this XSS-free.

### Side Effects

- `renderHtmlDocs` is also called from two non-message paths
  (`design.js:2981`, `:3039` — the workspace-filter change and the search-input
  handler), both re-deriving from `state._lastHtmlDocsMsg`. Any invariant added
  inside `renderHtmlDocs` fires on those paths too; that is intended (a search
  that matches nothing must not blank the pane) but it means the diagnostic copy
  has to read sensibly when `state.htmlDocsSearch` is non-empty.
- Persisted state is touched read-only. No `persistTab` / `saveState` change.
- `dist/` is deliberately untouched (see Proposed Changes #4).

### Dependencies & Conflicts

- `LocalFolderService.listHtmlFiles()` skips dotfiles, symlinks and
  `_EXCLUDED_DIRS` and caps depth at `_MAX_DEPTH`. Files under
  `node_modules`/`.git`/an excluded dir, or deeper than `_MAX_DEPTH`, are
  silently absent — check the excluded set when reproducing.
- **Multi-workspace / multi-root (product scope, preserve).** `htmlDocsReady`
  carries `folderPathsByRoot` and nodes tagged `metadata.root`; the
  `html-workspace-filter` dropdown filters by root. Two verified asymmetries:
  1. **`metadata.root` is conditional** (`DesignPanelProvider.ts:997`,
     `...(f._root ? { root: f._root } : {})`). A host whose workspace root is the
     empty string (standalone with no folder open) produces **untagged** nodes;
     any non-empty filter value then drops every node while
     `getCurrentFolderPaths` still returns paths for that root → docs vanish,
     headers with count 0 remain.
  2. **Cross-root dedup keeps the first root only.** `seenFilePaths`
     (`:1221`, `:1233`) dedups by absolute path across roots, so a folder
     configured in **two** roots yields files tagged with root A only. Filter to
     root B and the files disappear while B's `folderPaths` still lists the
     folder. Reproduce with both a single root and two roots.
- **Persisted `previews.source`.** `restoredTabState` can restore
  `previews.source = 'html-preview'` and route `activeTab` through
  `switchTab('previews')` → `selectPreviewsSource('html-preview')` at startup
  (`design.js:3207-3225`). The bug may reproduce on reload, not only on manual
  dropdown change — test both.
- **No folders configured vs folders configured but empty** produce different
  `renderHtmlDocs` branches (`:1027` vs `:1044` vs `renderFolderGroupedDocs`).
  Each empty-state shown must be accurate.
- **Search box.** `state.htmlDocsSearch` filters doc nodes (`:1039-1042`); a
  stale non-empty search value could hide all docs. Verify `htmlDocsSearch` is
  `''` on a clean repro.
- **Sidebar collapsed** — see cause (E). Confirm the sidebar is not merely
  collapsed before treating this as a render bug.

## Dependencies

None. No other plan needs to land first; every file touched
(`src/webview/design.js`) is owned by this plan alone.

Orchestration note (PRD "one agent stream per provider file"): if change #3's
retirement is ever revisited, `src/services/DesignPanelProvider.ts` must not be
edited concurrently by another Design-panel stream.

## Adversarial Synthesis

**Risk Summary.** The dominant risk was misdiagnosis: the original plan's
top-ranked cause (a dropped seat-addressed push) is refuted by the transport
code, and its change #3 would have *introduced* the multi-seat drop it claimed
to fix. Remaining risks are (a) patching a persisted-collapse problem (cause E)
with a render change, and (b) touching the shared folder-grouping helpers and
regressing the design/images/tickets trees. Mitigations: triage from the static
markup's own empty-state before writing code (zero instrumentation); keep the
new invariant inside `renderHtmlDocs` so shared helpers stay byte-identical;
keep every render idempotent because the browser host delivers each listing
twice.

## Proposed Changes

### 1. `src/webview/design.js` — make a blank pane structurally impossible (primary fix)

This replaces "instrument, then decide" as the *first* action. It is a single
caller-side change to `renderHtmlDocs` (`:997`) with three parts:

**(a) Wrap the body so a throw surfaces instead of blanking the pane.**

```js
function renderHtmlDocs(rootEntry) {
    const { sourceId, nodes, folderPaths } = rootEntry;
    const treePaneHtml = document.getElementById('tree-pane-html');
    if (!treePaneHtml) return;
    try {
        // ...existing body...
    } catch (err) {
        console.error('[html-preview] renderHtmlDocs threw:', err, rootEntry);
        const box = document.createElement('div');
        box.className = 'empty-state';
        box.style.cssText = 'padding:12px;color:var(--accent-red);';
        box.textContent = 'HTML preview list failed to render: '
            + (err && err.message ? err.message : String(err));
        treePaneHtml.appendChild(box);
    }
}
```

Note `appendChild` + `textContent`, not `innerHTML = …`: the toggle row is
already appended by the time most throws can happen, so preserving it keeps
Manage Folders reachable, and `textContent` keeps an error string containing a
filesystem path from becoming markup.

**(b) Assert the render actually produced something** — the guard that catches
cause (D), which throws nothing and shows nothing. Immediately after the
`renderFolderGroupedDocs(...)` call at `:1067`:

```js
renderFolderGroupedDocs(docList, docNodes, folderNodes, folderPaths, search,
    (doc) => createHtmlDocCard(doc, sourceId), 'html-previews', htmlFolderActions);

// Invariant: a non-empty docNodes list MUST produce at least one child. Folder
// grouping keys every append on `metadata.sourceFolder` and silently drops nodes
// without one (design.js:840-847), so a listing whose nodes lack sourceFolder —
// or whose sourceFolder values match no configured folderPath — renders nothing
// and shows no empty-state. Report it in the pane instead of leaving it blank.
if (docList.childElementCount === 0) {
    const ungrouped = docNodes.filter(d => !(d.metadata && d.metadata.sourceFolder)).length;
    console.warn('[html-preview] render produced no rows', {
        docNodes: docNodes.length, folderPaths: (folderPaths || []).length,
        ungrouped, search
    });
    const box = document.createElement('div');
    box.className = 'empty-state';
    box.style.cssText = 'padding:12px;font-size:12px;color:var(--text-secondary);';
    box.textContent = docNodes.length + ' HTML file(s) found but none could be grouped'
        + ' under a configured folder' + (ungrouped ? ' (' + ungrouped + ' missing a source folder)' : '')
        + '. Use Manage Folders to re-add the folder.';
    docList.appendChild(box);
}
```

Deliberately placed in `renderHtmlDocs`, **not** inside
`renderFolderGroupedDocs` — that helper is shared with the design, images,
tickets and stitch-html trees (`design.js:800`), and the PRD's byte-compat
contract makes a caller-side guard strictly cheaper to verify than a shared-helper
change. If the same blankness is later confirmed on a sibling tree, lift the
invariant then, with all consumers re-verified.

**(c) Keep boundary logging, minimal.** Two lines, not four — the invariant in
(b) already reports the render outcome, so logging only needs to cover the
round-trip:

```js
} else {
    console.log('[html-preview] posting refreshDocsForTab', state.previewsSource);
    vscode.postMessage({ type: 'refreshDocsForTab', tab: state.previewsSource });
}
```

```js
case 'htmlDocsReady':
    console.log('[html-preview] htmlDocsReady received',
        { nodes: (msg.nodes||[]).length, folderPathsByRoot: msg.folderPathsByRoot,
          filter: state.htmlWorkspaceRootFilter });
    state._lastHtmlDocsMsg = msg;
    // ...existing...
```

`filter` is added to the log because the two multi-root asymmetries in the
Edge-Case audit are invisible without it.

Together, (a)+(b) convert every unknown-cause blank pane into a self-describing
state, and (c) keeps the round-trip visible. **Idempotency**: all three additions
run inside a function that begins with `innerHTML = ''`, so the browser's double
delivery still ends at one correct render.

### 2. `src/webview/design.js` — clearer empty-state when no folders configured

In `renderHtmlDocs`, the "No HTML preview files found." branch (`:1027-1030`)
gives no path forward. Replace it with an actionable empty-state that links to
the Manage Folders modal (which already exists via `openFoldersModal('html')`):

```js
if ((!nodes || nodes.length === 0) && (!folderPaths || folderPaths.length === 0)) {
    docList.innerHTML = '<div class="empty-state" style="padding:12px;font-size:12px;color:var(--text-secondary);">'
        + 'No HTML folders configured. '
        + '<a href="#" id="html-empty-add-folder" style="color:var(--accent-teal);text-decoration:underline;">Add a folder</a>'
        + '</div>';
    const addLink = docList.querySelector('#html-empty-add-folder');
    if (addLink) addLink.addEventListener('click', (e) => { e.preventDefault(); openFoldersModal('html'); });
    return;
}
```

This addresses cause (C) directly and improves UX regardless of the others. Two
constraints:

- Keep the second empty-state at `:1044-1047` ("No matching HTML preview files
  found.") distinct — it fires when a **search** or an unmatched root filter
  empties a non-empty listing, where "Add a folder" would be wrong advice.
  Three empty-states now exist (unconfigured / no-match / ungroupable); they must
  read as three different situations, because the copy is the diagnosis.
- The static markup's own message ("Configure a folder to browse HTML files",
  `design.html:3854`) is a fourth string for the same situation. Leave it as-is —
  it is the pre-render state and its presence is the triage signal from the Goal
  section — but do not let the two diverge in meaning.

### 3. ~~`src/services/DesignPanelProvider.ts` — guard/repair the `refreshDocsForTab` → `htmlDocsReady` round-trip~~ — RETIRED

> **Superseded:** *In `_handleMessage`'s `refreshDocsForTab` arm, thread
> `message.originatorId` into the `htmlDocsReady` payload so the originating client
> does not drop its own listing (`this.postMessage({ ...payload, originatorId:
> message.originatorId })`), with a note about avoiding a double-push.*
>
> **Reason:** It fixes a non-problem and creates a real one. `_sendHtmlDocsReady`
> posts an **untagged** payload (`DesignPanelProvider.ts:1243-1251`), and
> `design.js:3069` drops only messages that *carry* a mismatching `originatorId` —
> untagged pushes always pass, as that code's own comment states. Adding an
> `originatorId` would flip this listing from "everyone receives it" to "only the
> requesting seat receives it", so a second open design panel (or the browser
> cockpit alongside the editor) would stop refreshing its HTML tree on the first
> seat's folder change — a genuine multi-seat regression, in the exact area the
> cited commits were hardening. The double-push caveat the original text raised is
> also real and unresolved: `_sendHtmlDocsReady` already calls `this.postMessage`
> internally, so the re-address would deliver two copies.
>
> **Replaced with:** No transport change. `refreshDocsForTab` already returns the
> payload in-body (`:3919`), which satisfies the PRD's return-in-body contract and
> is how the browser host receives it (`transport.js:315-319`); the editor host
> receives it via the untagged push. If the triage table's first row is ever
> observed (static empty-state still on screen after a dropdown switch), debug it
> as a **missing send** — confirm the arm is reached and `_getWorkspaceRoots()` is
> non-empty — not as an addressing problem.

### 4. No `dist/` changes

Per `CLAUDE.md`, `dist/` is not used during dev/testing — all verification is
via an installed VSIX. Do not edit `dist/webview/design.html` or
`dist/webview/design.js`; the `src/` edits are the source of truth.

## Verification Plan

1. **Triage before coding (zero instrumentation).** Open the Previews tab,
   switch the dropdown to HTML Previews, and classify the sidebar against the
   four-row table in the Goal section. Record which row it is. Do this on the
   host the user reported first, then the other host.
   - Row 1 (static text + no Manage Folders) → missing send; debug the arm, do
     **not** apply change #3 (retired).
   - Row 2 (Manage Folders, nothing below) → cause (B) or (D); changes #1(a)+(b)
     both diagnose and fix it.
   - Row 3 (an empty-state message) → cause (C); change #2.
   - Row 4 (40px strip) → cause (E); no render fix — clear the persisted
     `htmlPreviewCollapsed` and confirm the pane returns.
2. **Reproduce on both hosts.** Editor: Switchboard design panel in VS Code,
   webview devtools console (Developer: Open Webview Developer Tools). Browser:
   the `npx`/standalone cockpit Design panel, browser devtools. The render path
   is shared; the transport is not (see Host matrix), so a fix verified on one
   host is unverified on the other.
3. **Invariant fires.** With change #1(b) in place, force the ungroupable case
   (e.g. a listing whose nodes lack `metadata.sourceFolder`) and confirm the
   pane shows "N HTML file(s) found but none could be grouped…" plus the
   `[html-preview] render produced no rows` warning — never a blank pane.
4. **Throw path.** Temporarily throw inside `renderFolderGroupedDocs`; confirm
   the pane shows the red render-failure box **and keeps** the Manage Folders
   toggle row, then revert the temporary throw.
5. **Empty-state UX.** With no folders configured, confirm the sidebar shows
   "No HTML folders configured. Add a folder" and the link opens the Manage
   Folders modal. Add a folder containing a `.html` file and confirm the card
   appears and "Serve & Open" loads it in the iframe. Then type a
   non-matching search term and confirm the *different* "No matching HTML
   preview files found." copy appears (not the "Add a folder" copy).
6. **Idempotency in the browser.** In the browser cockpit, switch to HTML
   Previews and confirm `renderHtmlDocs` runs twice (two `htmlDocsReady` logs)
   yet the sidebar shows each folder header **once** and each file **once**.
7. **No regression on sibling tabs.** Switch the dropdown to Stitch HTML and
   Images; confirm both still populate their sidebars and their workspace-filter
   dropdowns still work. Switch to the Design tab and confirm its sidebar still
   lists design-system docs. (These share `renderFolderGroupedDocs` /
   `buildAccordionFolderHeader`, which this plan leaves byte-identical — the
   check is that it stayed that way.)
8. **Reload path.** With `previews.source` persisted to `html-preview`, reload
   the panel and confirm the HTML Previews sidebar populates on load, not only
   on manual dropdown change.
9. **Multi-workspace (product scope).** With two roots open:
   - configure HTML folders in both and confirm `html-workspace-filter` filters
     correctly per root;
   - configure the **same** folder in both roots and confirm the dedup
     asymmetry (`seenFilePaths`) is visible/absent as expected — files must not
     silently vanish under the second root's filter without an empty-state;
   - confirm a root whose `metadata.root` is absent (empty-string root) does not
     produce a blank pane — the invariant must report it.
10. **Multi-seat.** Open the design panel in the editor **and** the browser
    cockpit at once, add a folder in one, and confirm the other's HTML tree
    refreshes. This is the regression change #3 would have caused; it is now the
    check that the untagged push stayed untagged.

### Automated Tests

> Not executed during this planning pass — session directives were "skip
> compilation" and "skip tests". These are for the implementing coder.

- Existing suites to keep green: `src/test/design-*-contract.test.js`,
  `src/test/design-reply-addressing-regression.test.js`,
  `src/test/design-view-state-seats-contract.test.js` — the message-round-trip
  and seat contracts. `design-reply-addressing-regression` is the suite that
  would have caught change #3's regression; it must stay green untouched.
- New coverage worth adding (headless, DOM-free is not possible here, so
  jsdom-style or a contract assertion on the source): assert that
  `renderHtmlDocs` never leaves `.source-doc-list` empty when `docNodes` is
  non-empty — i.e. the invariant from change #1(b) exists and is reached after
  the `renderFolderGroupedDocs` call. A source-level contract test (the pattern
  the repo already uses for webview invariants) is sufficient and cheap.

---

**Recommendation: Send to Coder** (complexity 4).
