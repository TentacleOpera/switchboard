# Ticket detail H1: source the title from the sidebar row, not the detail cache

<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** Changes 4 and 5 are **already at HEAD** (the `localTicketFileRead` title override, and `renderTicketsTab` on `localTicketFilesListed`) — the file already says do not re-add them. Rewrite the Goal so the remaining scope is the single `resolveTicketTitle` helper and its three call sites.


## Goal

Make the ticket detail pane's H1 render from the same data the sidebar renders, so a title edited on the remote shows up after a refetch instead of staying pinned to whatever was cached the first time the ticket was opened.

### Reported symptom

"ClickUp ticket name gets out of sync. If I refetch the ticket it still has the old name if I edited it on the remote." Reported four times; four fixes did not resolve it. The sidebar row shows the correct name; the detail pane's H1 shows the old one.

### Reproduction (confirmed on ClickUp `86d3cwcpz`)

The remote title used to be `Locked clinical archive — 7yr / age-25 retention — 8 points`. The trailing `— 8 points` was deleted on the remote. After refetch the detail pane still renders the `— 8 points` version.

The decisive observation: **the string `— 8 points` exists nowhere on disk.** Not in the ticket `.md` file (filename, H1 and body all carry the corrected title and byte-match the remote `markdown_description`), not in either workspace's `kanban.db`, and not on the remote. It survives only in a webview-local `Map`.

### Root cause

The detail pane's H1 is not sourced from the ticket file or from the sidebar row. It is sourced from an in-memory task object owned by a cache built for an unrelated purpose, and there is no path by which a corrected title reaches it.

`src/webview/tickets.js`:

**1. The H1 renders from the cached task object.**
`renderTicketsClickUpTaskDetail` builds the heading at `:3484`:
```js
let contentHtml = `<h1>${escapeHtml(task.title || task.identifier || task.id)}</h1>`;
```
where `task` is `selectedClickUpIssue.task`. `renderTicketsLinearTaskDetail` does the same at `:3374`.

> **Superseded:** the render sites were named `renderTicketsClickUpPanel` (`:3442`) and `renderTicketsLinearPanel` (`:3337`).
> **Reason:** verified against HEAD — `renderTicketsClickUpPanel` (`:1258`) and `renderTicketsLinearPanel` (`:1223`) are toolbar/dispatch functions that contain no `<h1>`. They call `renderTicketsClickUpTaskDetail` (`:3413`) / `renderTicketsLinearTaskDetail` (`:3303`), which own the heading. Patching the named functions would have edited the wrong bodies. Line numbers also drifted by ~40.
> **Replaced with:** `renderTicketsClickUpTaskDetail` `:3484` and `renderTicketsLinearTaskDetail` `:3374`. These are the only two `<h1>` sites in the file (`grep -n '<h1>' src/webview/tickets.js` → `3374`, `3484`, plus one comment at `:6899`).

**2. The file's title is read and then discarded.**

> **Superseded:** "The `localTicketFileRead` handler (`:7683`) strips the file's leading H1 … `message.title` is used **only on a cache miss**. Whenever the cache has an entry, `existing.task` wins wholesale and the freshly-read title is dropped."
> **Reason:** this half has **already been fixed at HEAD**. `localTicketFileRead` (`:7821`) now spreads the cache entry and overrides the title: `task: existing?.task ? { ...existing.task, title: nextTitle || existing.task.title, name: … } : { … }`, with an in-code comment naming the old `existing?.task || {…}` short-circuit as "the stale-heading half of the reported bug". The shared applier `_applyTicketFilePayloadToSelected` (`:6886`) does the same for both `localTicketFileRead` and `ticketFileChanged`, and `_selectTicketFromCard` (`:3155`) now posts `readLocalTicketFile` **unconditionally** on every card click, not only on a cache miss.
> **Replaced with:** the file→cache title path is live. What remains is that the **renderers still read `task.title` directly**, so the pane's heading is only as fresh as the last file read that happened to land — see the residual paths below.

**3. The live API re-fetch that would carry the new title is suppressed.**
Card click (`:3155`):
```js
const cachedClickUp = clickUpTaskDetailCache.get(id);
if (cachedClickUp) { selectedClickUpIssue = cachedClickUp; renderTicketsClickUpPanel(); }
…
if (!cachedClickUp || !cachedClickUp.detailsFetched) {
    vscode.postMessage({ type: 'clickupLoadTaskDetails', taskId: id, … });
}
```
`clickupTaskDetailsLoaded` (`:7650`) *does* set `task: message.task` with the correct live title — but once `detailsFetched: true` is set, that request is never issued again. This is still true at HEAD.

### The residual defect at HEAD (what this plan actually fixes)

With the file→cache repair already in, two live paths still show a stale H1, because the renderers read the cache instead of the list:

- **Pane open, list reloads, no click.** `localTicketFilesListed` (`:7764`) rebuilds `clickUpProjectIssues` / `linearProjectIssues` from the file-backed lister and calls `renderTicketsTab()` (`:7817`). The sidebar row updates; the pane re-renders from `selectedClickUpIssue.task.title`, which nothing in that arm touched. **The heading does not move.** This is the reported symptom: refetch → sidebar right, pane wrong.
- **First paint on click.** `_selectTicketFromCard` assigns `selectedClickUpIssue = cachedClickUp` and renders *synchronously*, then posts `readLocalTicketFile`. The stale title is painted first and only corrected when the async read lands — a visible flash, and a permanent stale heading if the read fails (`reason: 'not-imported'` breaks without patching, `:7822`).

Both paths disappear the moment the H1 resolves from the list row, which is rebuilt from disk on every list load.

### Why the sidebar is right and the pane is wrong

The sidebar renders `clickUpProjectIssues`, rebuilt from `localTicketFilesListed` on every list load — file-backed and therefore correct. The detail pane renders a separate long-lived cache. Two sources, one of which never refreshes on its own.

### Why the divergence exists at all (and why the fix is a deletion, not a patch)

`clickUpTaskDetailCache` exists because the pane needs fields the sidebar row does not carry: `subtasks`, `comments`, `attachments`, `renderedDescriptionHtml`, `descriptionMarkdown`. Those genuinely justify a separate heavier fetch. But that fetch returns one blob — `task` — and the **title rode along inside it** with no reason of its own to be there.

Two design errors compounded:
- the title was stored inside a cache scoped to a different concern, so it inherited that cache's lifetime; and
- that cache's freshness rule (`detailsFetched` — "we already have them, don't re-fetch") is correct for comments and attachments and wrong for a title that changes on the remote.

The code already concedes the sidebar row is an acceptable title source: on a cache **miss** the click handler seeds `selectedClickUpIssue` from exactly that (`clickUpProjectIssues.find(t => t.id === id)`, `:3168` / `:3185`). The cache simply shadows it whenever populated.

So the fix is to stop *reading* a title from the detail cache at all, rather than to keep merging a fresher title into it. That removes the divergence instead of adding invalidation logic that has to be kept correct.

### Why four previous fixes missed it

All four targeted the import/refetch path — the delta cursor, the `!authoritative` conflict guard, the stamp-before-orphan-cleanup ordering (pinned by `src/test/tickets-refetch-full-pull-regression.test.js`). That work is correct and this plan does not change it. The file refetch was never the problem: the H1 does not read the file.

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, frontend, ui
- **Project:** Browser Switchboard

## User Review Required

None. The fallback ordering (list row → drill-down row → file H1 / API title → id) is decided in this plan and needs no user input.

## Complexity Audit

### Routine
- Changing two render sites (`:3374`, `:3484`) to resolve the title from the list row.
- Adding one small title-resolution helper.
- Re-pointing `_drillDownParentTitle` (`:3539`) at the same helper.

### Complex / Risky
- **Drill-down subtasks are not in `clickUpProjectIssues`.** `_drillDownSubtasks` (`:138`) is a parallel array populated from `detail.subtasks` in `_maybeEnterDrillDown` (`:3529`), and `_drillDownParentTitle` (`:3539`) reads `detail.task.title` / `detail.issue.title` — the same cache this plan is moving off. The resolver must cover subtask rows or subtask headings fall back to a raw id.
- **A ticket can be opened with no list row at all** — deep-linked, or clicked immediately after a rename-driven re-slug before the list reloads. The fallback chain has to be ordered so the pane never renders a bare task id.
- **Linear must change in lockstep.** `renderTicketsLinearTaskDetail` (`:3374`) has the identical structure with `issue.title || issue.identifier || issue.id`. Fixing only ClickUp leaves the same bug on the other provider — the exact host-drift trap that has bitten this repo before.
- **Edit mode round-trips the title.** `btn-save-ticket-edit` (`:5173`) composes `# ${title}\n\n${body}` from `#ticket-edit-title` and writes it back to the file, to `task.title`/`issue.title` in the cache, **and** to the list row (`listItem.title = title`, `:5194` / `:5199`). With the resolver reading the list row first, that list-row write becomes the load-bearing one. Both ends must move together.
- **Same-block collision with the empty-description plan.** The line this plan rewrites (`:3374` / `:3484`) sits directly above the description branch that `feature_plan_20260811144522_tickets-empty-delete-save-bounce.md` rewrites, and both plans quote the same "before" text. See **Dependencies**.

## Edge-Case & Dependency Audit

| Case | Required behaviour |
| --- | --- |
| Ticket present in `clickUpProjectIssues` / `linearProjectIssues` | H1 renders the list row's title. Always current — the list is file-backed and rebuilt by `localTicketFilesListed`. |
| Ticket is a drill-down subtask | Resolve from `_drillDownSubtasks` before falling back. |
| No list row (deep link, list not yet loaded) | Fall back to the passed task/issue object — which at that point already carries the file's H1 (`localTicketFileRead` writes `message.title` into it), then `identifier`, then the id. Never render a bare id when any name is known. |
| Remote rename → refetch, pane already open | `localTicketFilesListed` already calls `renderTicketsTab()` (`:7817`); with the resolver in place that existing call becomes the fix. No new re-render hook is needed. |
| Local edit via the ticket editor | Saved title must reach the file, the list row, and the pane. `btn-save-ticket-edit` already writes all three; the list-row write is now load-bearing and must not be deleted as redundant. |
| Title edited locally *and* remotely | Out of scope. The existing `localDescription` conflict handling governs; this change must not alter it. |
| Ticket with no title anywhere | Render the id, as today. |
| Linear tickets | Same behaviour via `identifier` as the intermediate fallback. |

**Race conditions.** One, and it is closed by this change rather than opened: `_selectTicketFromCard` renders synchronously from the cache and *then* posts `readLocalTicketFile`. Today that paints a stale heading until the async read lands. With the resolver, the synchronous render already reads the list row, so the read result can only confirm it.

**Security.** None. `escapeHtml` still wraps the resolved string at both sites; the resolver returns a plain string from data already rendered in the sidebar.

**Side effects.** The render-suppression memos (`_lastTicketsDetailContentHtml` `:255`, `_lastTicketsClickUpDetailContentHtml` `:258`) compare the whole `contentHtml`, which contains the `<h1>`. A changed title therefore invalidates the memo and repaints — no extra invalidation needed.

**Dependencies (all in `src/webview/tickets.js`)**
- `renderTicketsClickUpTaskDetail` `:3484`, `renderTicketsLinearTaskDetail` `:3374` — the two H1 render sites.
- Card-click handler `_selectTicketFromCard` `:3155` — cache-hit shortcut and `detailsFetched` gate.
- `localTicketFileRead` `:7821`, `ticketFileChanged` `:7894`, shared applier `_applyTicketFilePayloadToSelected` `:6886` — file-read handlers (already title-correct; do not regress them).
- `clickupTaskDetailsLoaded` `:7650`, `linearTaskDetailsLoaded` `:7616` — API handlers.
- `_maybeEnterDrillDown` `:3529` — `_drillDownParentTitle` `:3539`.
- `btn-save-ticket-edit` `:5173` — local rename write-back.
- `localTicketFilesListed` `:7764` — list rebuild + the existing `renderTicketsTab()` call at `:7817`.

No extension-host changes are required. `TicketsPanelProvider.listLocalTicketFiles` already ships a correct per-ticket `title`, and `readLocalTicketFile` already ships the file's H1 as `title`. Both are consumed today and neither needs to change. No verb signature changes, so no `verbSchemas.ts` entry and no movement in the `Tickets` return-contract ratchet ceiling.

## Dependencies

- `feature_plan_20260811144522_tickets-empty-delete-save-bounce.md` — **shared-block dependency, not a functional one.** That plan rewrites the description branch immediately below this plan's `<h1>` line in both renderers. Land this plan **first**, then layer the description fix onto the rewritten block. Splitting the two across parallel streams produces a merge in which one silently reverts the other.
- No session dependencies (`sess_…`) — none recorded for this work.

## Adversarial Synthesis

**Risk summary.** The change is small but sits on a block another subtask also rewrites, so the dominant risk is merge-order, not logic: land this first and layer the description fix on top. The second risk is partial application — fixing ClickUp without Linear, or the pane without the drill-down heading, leaves a surface that still diverges; the grep guard in the verification plan is what prevents that. The third is a future cleanup deleting `listItem.title = title` in the save handler as "redundant", which would silently break local renames now that the list row is the read source — mitigated by an explicit in-code comment.

## Proposed Changes

### 1. Add one title resolver — the single source of truth for a displayed ticket title

Place it next to the other tickets helpers in `src/webview/tickets.js` (function declarations in this IIFE are hoisted, so placement relative to the renderers is free).

```js
// The title a ticket DISPLAYS is always the one the sidebar shows. It is file-backed
// and refreshed on every list load (localTicketFilesListed), so a remote rename lands
// here on the next refetch.
//
// It is deliberately NOT read from the detail cache: that cache exists for subtasks,
// comments, attachments and rendered description, and its `detailsFetched` freshness
// rule ("already have them, don't re-fetch") is correct for those and wrong for a
// title that changes remotely. Reading the title there pinned it to whatever was
// cached on first open, which no refetch could reach.
//
// fallbackTask is the cached task/issue object. By the time it is consulted it has
// already been patched with the file's H1 by localTicketFileRead /
// _applyTicketFilePayloadToSelected, so it is the correct second choice — it is only
// stale relative to the list, never relative to the file.
function resolveTicketTitle(provider, id, fallbackTask) {
    const rows = provider === 'linear' ? linearProjectIssues : clickUpProjectIssues;
    const row = (rows && rows.find(t => t.id === id))
        || (_drillDownSubtasks && _drillDownSubtasks.find(s => s.id === id));
    if (row && row.title) { return row.title; }
    // No list row (deep link, or list not loaded yet): the cached object's title
    // (= the file's H1 once read), then the identifier, then the id.
    return (fallbackTask && (fallbackTask.title || fallbackTask.identifier)) || id;
}
```

### 2. Render both H1s through it

```js
// Linear — renderTicketsLinearTaskDetail, :3374
let contentHtml = `<h1>${escapeHtml(resolveTicketTitle('linear', issue.id, issue))}</h1>`;

// ClickUp — renderTicketsClickUpTaskDetail, :3484
let contentHtml = `<h1>${escapeHtml(resolveTicketTitle('clickup', task.id, task))}</h1>`;
```

Only the `<h1>` expression changes. The description branch immediately below it is owned by `feature_plan_20260811144522` — leave it byte-identical here so the two changes compose instead of colliding.

### 3. Route the drill-down parent heading through the resolver

`_maybeEnterDrillDown` (`:3539`) currently reads the cache directly:

```js
_drillDownParentTitle = provider === 'linear'
    ? ((detail.issue && (detail.issue.title || detail.issue.identifier)) || '')
    : ((detail.task && (detail.task.title || detail.task.name)) || '');
```

**Replace with:**

```js
// Same source as the pane heading — otherwise the drill-down breadcrumb and the
// H1 above it can disagree after a remote rename.
_drillDownParentTitle = resolveTicketTitle(provider, id, provider === 'linear' ? detail.issue : detail.task);
```

### 4. File-H1-into-cache write-back — already at HEAD, do not re-add

> **Superseded:** "In `localTicketFileRead` (`:7683`), stop dropping `message.title` on a cache hit … Apply the same to the Linear branch and to `ticketFileChanged` (`:7729`)."
> **Reason:** HEAD already does exactly this, in both the from-scratch branch of `localTicketFileRead` (`:7860`–`:7885`) and the shared patcher `_applyTicketFilePayloadToSelected` (`:6886`), which serves `localTicketFileRead` and `ticketFileChanged` from one body. Re-applying it would duplicate live code.
> **Replaced with:** no change. Treat it as a **regression guard**: `_applyTicketFilePayloadToSelected` must keep `task: { ...prev.task, title: nextTitle, name: nextTitle }` and `localTicketFileRead` must keep `{ ...existing.task, title: nextTitle || existing.task.title }`. Assert both in the grep guard (Verification 4) so a future cleanup cannot reintroduce the `existing?.task || {…}` short-circuit.

### 5. Open-pane refresh on list reload — already wired, becomes load-bearing

> **Superseded:** "On `localTicketFilesListed`, if the reloaded list contains the currently-selected ticket, call `renderTicketsTab()`."
> **Reason:** `localTicketFilesListed` (`:7764`) already ends with `renderTicketsTab();` (`:7817`), unconditionally. Adding a second, conditional call would double-render.
> **Replaced with:** no code change. Record that the existing `renderTicketsTab()` call is what makes change 2 visible without a click — it re-runs the renderers, which now read the freshly rebuilt list row. Add a one-line comment at `:7817` saying the call is load-bearing for the pane heading, so it is not "optimised" behind a dirty check later.

### 6. Keep the local-rename write-back consistent

`btn-save-ticket-edit` (`:5173`) already updates the list row alongside the cache:

```js
const listItem = clickUpProjectIssues.find(t => t.id === id);
if (listItem) { listItem.title = title; }   // :5193-5194  (Linear: :5198-5199)
```

Add a comment marking it load-bearing: with `resolveTicketTitle` reading the list row first, deleting this line makes a local rename display the *old* title until the next list reload, even though the file and the cache are both correct.

## Verification Plan

### Automated Tests

1. **Grep guard (new, `src/test/tickets-title-source-guard.test.js`).** Static assertions over `src/webview/tickets.js`:
   - every `<h1>` render site routes through `resolveTicketTitle(` — i.e. no `<h1>` template literal in the file contains `task.title` / `issue.title` directly;
   - `resolveTicketTitle` consults `clickUpProjectIssues` / `linearProjectIssues` **before** its `fallbackTask` argument;
   - `_drillDownParentTitle` is assigned from `resolveTicketTitle(`;
   - `_applyTicketFilePayloadToSelected` still spreads `...prev.task` with an overriding `title:` (guards the already-fixed half against regression);
   - `btn-save-ticket-edit` still contains `listItem.title = title;` for both providers.
   This is the check that keeps the divergence from growing back.
2. **`src/test/tickets-refetch-full-pull-regression.test.js` must pass unchanged.** This plan changes no import-path behaviour; a failure there means the fix drifted into the wrong half of the system again — exactly how the four previous attempts missed.
3. **`src/test/tickets-description-markdown-fallback.test.js` must pass unchanged.** It slices 700 characters starting at `if (selected…renderedDescriptionHtml) {`, which begins *below* the `<h1>` line, so this plan's edit is outside its window. If it goes red, the H1 edit strayed into the description branch owned by the other subtask.

### Manual

4. **The reported case, end to end.** Rename `86d3cwcpz` on ClickUp (add then remove a ` — 8 points` suffix). Click Refetch. The detail-pane H1 must track the remote through both edits. Pre-fix this reproduces; post-fix it must not.
5. **Without clicking Refetch.** Rename on the remote, then hit Refresh (delta). The sidebar updates today; assert the pane's H1 now updates with it.
6. **Pane already open during the reload.** Rename remotely while the ticket is open, refetch, and assert the heading changes without navigating away and back (covers change 5 — the existing `renderTicketsTab()` call).
7. **Drill-down.** Open a parent with subtasks, drill in, and assert both the parent breadcrumb and each subtask heading resolve to real titles, never a bare id.
8. **No list row.** Deep-link a ticket before the list has loaded and assert the H1 shows the file's H1, not the id.
9. **Local rename.** Rename via the ticket editor and assert the new title appears in the pane, the sidebar row, and the file's H1 — then push and confirm the remote matches.
10. **Linear parity.** Repeat 4, 6 and 7 against a Linear issue.

---

**Recommendation:** Complexity 3 → **Send to Intern**, with one constraint: this must land **before** `feature_plan_20260811144522` (empty-description) and on the same stream, because both rewrite adjacent lines of the same two blocks.
