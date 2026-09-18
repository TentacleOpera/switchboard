# Subtask cards in the Tickets sidebar always read "local" — their sync status is never fetched

## Goal

Make subtask cards in the Tickets sidebar drill-down show their real sync state (`synced` / `modified` / genuinely local-only) instead of unconditionally rendering the `local` badge. Right now every subtask card lies: the badge is a fallback that fires because sync status was never requested for subtasks, so a subtask that is perfectly in sync with its remote is labelled the same as one that has never been pushed.

### Problem

Drill into a parent ticket's subtasks in the Tickets sidebar. Every subtask card carries a `local` badge, regardless of whether the subtask has a local file, whether that file is in sync, or whether it has local edits pending. The badge is worse than useless there — it is actively wrong, and it hides the one state an operator actually watches for (`modified`, i.e. "this has unpushed edits").

### Root cause (confirmed against the code)

> *Line references below were re-verified against HEAD on 2026-08-08.*

The badge has a three-way rendering but only a two-way *input*, and the drill-down list never supplies the input at all.

**The badge falls through to `local` on any unknown value.**

`src/webview/tickets.js:576-582`:

```js
    // Builds the sync-status badge shown bottom-left on each card. Renders for all
    // states (synced / modified / local-only) so it's present on every card.
    function _ticketSyncBadge(syncStatus) {
        if (syncStatus === 'modified') { return `…ticket-sync-modified">modified</span>`; }
        if (syncStatus === 'synced')   { return `…ticket-sync-synced">synced</span>`; }
        return `…ticket-sync-local">local</span>`;
    }
```

There is no `undefined` arm. `undefined` ("we have not asked yet") and `'local-only'` ("we asked; there is no remote-backed file") collapse into the same pixel. The helper's own comment claims it renders "all states (synced / modified / local-only)" — but the fallback swallows a fourth state the code does produce.

**Subtask ids are never sent to the backend.**

`_requestTicketSyncStatuses` (`src/webview/tickets.js:1345-1362`) builds its id list from the top-level arrays only:

```js
        const issues = lastIntegrationProvider === 'clickup' ? clickUpProjectIssues : linearProjectIssues;
        if (!issues.length) return;
        vscode.postMessage({ type: 'getTicketSyncStatuses', provider: …, ids: issues.map(t => t.id), … });
```

`_drillDownSubtasks` (declared `tickets.js:138`) is not consulted. Subtasks arrive from the detail fetch (`_maybeEnterDrillDown`, `tickets.js:3444-3458`, `_drillDownSubtasks = subs` at 3453) as raw API objects — they carry no `syncStatus` property at all.

**The response arm cannot patch them either.**

`case 'ticketSyncStatusesLoaded'` (`tickets.js:7433-7448`) maps over `clickUpProjectIssues` / `linearProjectIssues` and nothing else. Even if subtask ids were sent, the returned statuses would never reach `_drillDownSubtasks`.

**So the drill-down renderers hand `undefined` straight to the badge.**

`renderTicketsLinearList` (`tickets.js:1080-1089`) and `renderTicketsClickUpList` (`tickets.js:1159-1168`) both do `subtasks.map(_renderLinearTicketCard)` / `_renderClickUpTicketCard`, and those renderers call `_ticketSyncBadge(task.syncStatus)` / `_ticketSyncBadge(issue.syncStatus)` (`tickets.js:623`, `655`). `issue.syncStatus` is `undefined` → the fallback fires → `local`, always, for every subtask.

The backend is not the problem: `getTicketSyncStatuses` (`src/services/TicketsPanelProvider.ts:1851-1882`) resolves any id list against `getImportedTickets()` and returns `'synced' | 'modified' | 'local-only'` per id. Its schema already accepts an arbitrary `ids` array (`verbSchemas.ts:955-966`). It would answer correctly for subtask ids if it were asked.

**A fourth mechanism erases statuses on the top-level list too — currently invisible.**

`localTicketFilesListed` (`tickets.js:7449-7493`) rebuilds `clickUpProjectIssues` / `linearProjectIssues` wholesale from the local-file payload, carrying `syncStatus: t.syncStatus` (lines 7468, 7484). The backend's local-file lister does not emit a `syncStatus` field, so that value is `undefined` — the rebuild **wipes** any status already applied. And at both call sites the request is fired *before* the list load (`_requestTicketSyncStatuses(); loadLocalTicketFiles();` at `tickets.js:6992-6993` and `7008-7009`), so a fast status reply is overwritten by the slower list reply. Today this is invisible: the wiped `undefined` renders as `local`, which is what the cards showed anyway. The moment `undefined` gets its own badge, the wipe becomes a visible, permanently-stuck state.

> Note: `src/webview/planning.js:8173-8175` carries an identical copy of this helper, but `planning.html` no longer hosts a tickets tab (no `data-tab="tickets"` / tickets-tab markup remains), so that copy is dead and is deliberately out of scope.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 3
> **Reason:** The original score assumed three localised edits in one file. Verification against HEAD surfaced a fourth mechanism — `localTicketFilesListed` rebuilding the issue arrays with an absent `syncStatus`, racing a request fired before the list load — which the new pending badge converts from invisible to permanently visible. Fixing it correctly means touching the list-load arm and its ordering as well, plus a `tickets.html` CSS addition. Still single-file-plus-stylesheet and low risk, but no longer a three-line change.
> **Replaced with:** **Complexity:** 4 → Coder.

## User Review Required

None. The pending state is rendered as a muted `checking` chip — ASCII only, no ellipsis or symbol glyph, because the panel font stack carries no symbol glyphs and an unsupported character renders as tofu. A `checking` badge that never resolves is an accepted, honest outcome: it means the sync-status fetch is broken, which is true, and is strictly better than the current permanent false `local`.

## Complexity Audit

### Routine
- The backend verb already accepts an arbitrary id list and already returns the three real states — no provider, schema or DB change (`verbSchemas.ts:955-966` types `ids` as a plain array).
- The response arm already knows how to splice statuses into an array; the drill-down array just needs the same treatment.
- The four call sites that already trigger `_requestTicketSyncStatuses` (`tickets.js:6992`, `7008`, `7185`, `7768`) need no new triggers if the drill-down set is folded into the existing request.
- The new badge modifier mirrors the three existing ones (`tickets.html:3056-3075`).

### Complex / Risky
- **Two states currently render identically.** Fixing only the id list still leaves `undefined` and `'local-only'` on the same badge. Both need distinct treatment, or the operator cannot tell "not yet known" from "genuinely never pushed" — and the in-flight window is exactly when the wrong label is most visible.
- **The request is scope-stamped.** `_requestTicketSyncStatuses` sends `listId` / `projectId` so the backend can stamp the broadcast reply for cross-panel scoping (`TicketsPanelProvider.ts:1855-1857`, and `_isForThisPanel(message)` at `tickets.js:7434`). Subtask ids must ride the *same* request under the same scope stamp; a second unscoped request would be dropped by the panel filter.
- **`syncStatus` must be written back to `_drillDownSubtasks`, not just to a render-local copy.** `_drillDownSubtasks` survives subtask-detail loads by design (`tickets.js:138`) and is re-read on every render; patching a transient copy loses the status on the next re-render.
- **Call-order dependency at the drill-down entry point.** `_isDrillDownActive(provider)` requires `_sidebarDrillDownParentId && _drillDownSubtasks && _drillDownProvider === provider` (`tickets.js:761-763`). A re-request fired between `_drillDownSubtasks = subs` and `_drillDownProvider = provider` sees the guard as false and silently omits every subtask id — the exact bug being fixed, reintroduced by a one-line misplacement.
- **The list-load wipe.** See root cause 4. Making `undefined` visible turns an existing latent race into a stuck badge; the list-load arm must preserve known statuses and re-request.
- **DOM-guard caching.** Both list renderers compare against `_lastTicketsIssuesContainerHtml` / `_lastTicketsClickUpIssuesContainerHtml` and skip the DOM write when the string is unchanged. Since the badge markup is part of that string, a status arriving late naturally invalidates the guard — but only if the status is actually written into the array the HTML is built from.

## Edge-Case & Dependency Audit

### Race Conditions
- **Drill-down entered before statuses return.** Render `undefined` as a neutral `checking` state rather than a wrong verdict; the arriving response re-renders with the real value.
- **Status reply vs. local-file reply.** Root cause 4. Both `linearProjectLoaded` (7008) and the ClickUp equivalent (6992) fire the status request *then* `loadLocalTicketFiles()`. If the status reply wins, `localTicketFilesListed` erases it. Mitigation below: preserve prior per-id status across the rebuild **and** re-request after the rebuild.
- **Backend failure branch leaves ids unresolved.** `getTicketSyncStatuses` returns `{ success: false, … statuses: {} }` when `workspaceRoot` is unresolvable or `ids` is empty (`TicketsPanelProvider.ts:1858-1866`). Those ids stay `undefined` and the badge stays `checking`. Accepted and stated in User Review Required — a stuck `checking` reports a broken fetch truthfully. Log once to the console on a `success === false` reply so it is diagnosable; do not add UI messaging for it.
- **Leaving drill-down:** `_drillDownSubtasks` is nulled on exit (`tickets.js:381`). The response arm must null-guard before mapping over it.

### Security
- None. No new message types, no new backend surface, no new persisted state. The existing verb is called with a longer id array.

### Side Effects
- **Top-level cards change during the in-flight window.** Before this change, a top-level card with no status yet read `local`; it now reads `checking` until the reply lands. This is a deliberate, visible behaviour change on a path that "already worked" — the old label was simply wrong earlier and right later. Manual verification must expect it rather than assert no change.
- **Slightly larger request payload** — the union of top-level and drill-down ids, de-duplicated.

### Dependencies & Conflicts
- **Duplicate ids:** a subtask may also appear in the top-level list (ClickUp cross-list children). De-duplicate the id array before posting; the backend keys `statuses` by id so duplicates are harmless but wasteful.
- **Empty drill-down:** `_requestTicketSyncStatuses` early-returns on `!issues.length`. With drill-down active and the top-level list empty (possible after a filter), the guard must consider the union, not just the top-level array, or subtask statuses are never requested.
- **Provider mismatch:** `_drillDownProvider` may not equal `lastIntegrationProvider` mid-switch. Only fold in subtask ids when `_isDrillDownActive(lastIntegrationProvider)` is true.
- **Id shape parity:** the top-level request already sends `t.id`, and the card renderers key on `task.id` / `issue.id` (`tickets.js:628`, `663`); the backend resolves `${provider}_${id}` against `getImportedTickets()`'s `slugPrefix`. Drill-down subtasks carry the same `.id` from the detail payload, so no id normalisation is needed.
- **Migrations:** none. No persisted state, settings or file format changes — this is webview render state only.
- **Files touched:** `src/webview/tickets.js`, `src/webview/tickets.html` (one new badge modifier beside `.ticket-sync-local`, lines 3072-3075).

## Dependencies

- No external session dependencies (`sess_*`) — this plan is self-contained.
- **Sibling ordering within this feature:** independent. It shares `src/webview/tickets.js` with `feature_plan_20260807161808_tickets-remote-attachments-presented-as-local-files.md`, but that plan edits only `renderAttachmentsList` (~2774-2837) while this one edits the badge helper (576-582), the request builder (1345-1362), the drill-down entry (3444-3458) and two response arms (7433-7493). Disjoint regions — merges cleanly in either order, but the two must not be edited by concurrent streams.

## Adversarial Synthesis

**Risk Summary.** Giving `undefined` its own badge is the whole point of the fix and also its main risk: it converts every silent status-resolution failure into a visible stuck `checking` chip. Two such failures exist — the drill-down guard reading false if the re-request is fired one line too early, and `localTicketFilesListed` rebuilding the issue arrays with an absent `syncStatus` while racing the reply. Both are fixed here (call after `_drillDownProvider` is set; preserve prior statuses across the rebuild and re-request after it). The residual stuck-`checking` case is a genuine backend failure and is reported honestly rather than papered over with a false `local`.

## Proposed Changes

### `src/webview/tickets.js` — distinguish "unknown" from "local-only" (`_ticketSyncBadge`, lines 576-582)

```js
    // Builds the sync-status badge shown bottom-left on each card.
    //
    // FOUR inputs, not three. `undefined` means "status not fetched yet" — it is NOT
    // the same as 'local-only', and collapsing them made every drill-down subtask card
    // claim it was local-only when its status had simply never been requested.
    //
    // The pending label is ASCII: this panel's font stack carries no symbol glyphs, so
    // an ellipsis or arrow renders as tofu.
    function _ticketSyncBadge(syncStatus) {
        if (syncStatus === 'modified')   { return `<span class="ticket-sync-badge ticket-sync-modified">modified</span>`; }
        if (syncStatus === 'synced')     { return `<span class="ticket-sync-badge ticket-sync-synced">synced</span>`; }
        if (syncStatus === 'local-only') { return `<span class="ticket-sync-badge ticket-sync-local">local</span>`; }
        return `<span class="ticket-sync-badge ticket-sync-pending">checking</span>`;
    }
```

### `src/webview/tickets.js` — include drill-down subtask ids in the request (`_requestTicketSyncStatuses`, lines 1345-1362)

```js
    function _requestTicketSyncStatuses() {
        // Same fix as loadLocalTicketFiles: don't bail on an empty workspace root
        // (the Tickets tab has none) — let the backend resolve it.
        if (!lastIntegrationProvider) return;
        const issues = lastIntegrationProvider === 'clickup' ? clickUpProjectIssues : linearProjectIssues;
        // Drill-down subtasks are rendered as full cards with the same badge, but they
        // arrive from the detail fetch carrying no syncStatus. Fold their ids into the
        // SAME request so they inherit this request's scope stamp — a second, unscoped
        // request would be discarded by _isForThisPanel on the way back.
        const drillIds = _isDrillDownActive(lastIntegrationProvider)
            ? (_drillDownSubtasks || []).map(s => s.id).filter(Boolean)
            : [];
        const ids = Array.from(new Set([...issues.map(t => t.id), ...drillIds])).filter(Boolean);
        if (ids.length === 0) return;
        vscode.postMessage({
            type: 'getTicketSyncStatuses',
            provider: lastIntegrationProvider,
            ids,
            workspaceRoot: ticketsWorkspaceRoot || undefined,
            // Pass the scope id so the backend can stamp it on the broadcast reply
            // (cross-panel contamination fix). ClickUp scopes by listId; Linear has
            // no server-side project scope but the picker value is sent for stamping.
            listId: lastIntegrationProvider === 'clickup' ? (clickUpSelectedListId || undefined) : undefined,
            projectId: lastIntegrationProvider === 'linear' ? (linearProjectPickerValue || undefined) : undefined
        });
    }
```

Note the guard changed from `if (!issues.length) return;` to a union check — with an empty top-level list and an active drill-down, the old guard skipped the request entirely.

### `src/webview/tickets.js` — splice statuses into the drill-down array (`ticketSyncStatusesLoaded`, lines 7433-7448)

```js
            case 'ticketSyncStatusesLoaded': {
                if (!_isForThisPanel(message)) { break; }
                const provider = message.provider;
                const statuses = message.statuses || {};
                if (message.success === false) {
                    // Ids stay unresolved and their badges stay `checking`. That is the
                    // honest report of a broken fetch — log it so it's diagnosable, but
                    // do NOT substitute a made-up status.
                    console.warn('[tickets] sync-status fetch failed:', message.error);
                }
                if (provider === 'clickup') {
                    clickUpProjectIssues = clickUpProjectIssues.map(t => ({ ...t, syncStatus: statuses[t.id] ?? t.syncStatus }));
                } else {
                    linearProjectIssues = linearProjectIssues.map(t => ({ ...t, syncStatus: statuses[t.id] ?? t.syncStatus }));
                }
                // Patch the drill-down set in place too — it is a separate array that the
                // sidebar renders from directly, and it survives subtask-detail loads, so a
                // render-local copy would lose the status on the next re-render.
                if (_drillDownSubtasks && _drillDownProvider === provider) {
                    _drillDownSubtasks = _drillDownSubtasks.map(s => ({ ...s, syncStatus: statuses[s.id] ?? s.syncStatus }));
                }
                renderTicketsTab();
                break;
            }
```

### `src/webview/tickets.js` — stop the list rebuild from wiping known statuses (`localTicketFilesListed`, lines 7449-7493)

The local-file payload carries no `syncStatus`, so the wholesale rebuild replaces every resolved status with `undefined`. Preserve what is already known, and re-request after the rebuild so anything genuinely unknown resolves.

```js
                // The local-file lister does not emit syncStatus, so a bare
                // `syncStatus: t.syncStatus` wipes every status already resolved by
                // ticketSyncStatusesLoaded — and both call sites fire the status request
                // BEFORE this load, so a fast reply loses that race. Carry the known
                // value forward; the re-request below fills anything still unknown.
                const prevSync = new Map(
                    (localProvider === 'clickup' ? clickUpProjectIssues : linearProjectIssues)
                        .map(t => [t.id, t.syncStatus])
                );
```

then in both branches use `syncStatus: t.syncStatus ?? prevSync.get(t.id)`, and after `renderTicketsTab();` add:

```js
                _requestTicketSyncStatuses();
```

This does not loop: `ticketSyncStatusesLoaded` re-renders but never re-requests.

### `src/webview/tickets.js` — re-request on entering drill-down (`_maybeEnterDrillDown`, lines 3444-3458)

> **Superseded:** place the call immediately after `_drillDownSubtasks = subs;` (line 3453) —
> ```js
> _drillDownSubtasks = subs;
> _requestTicketSyncStatuses();   // the new ids are only known now
> ```
> **Reason:** `_drillDownProvider` is assigned on the *next* line (3454), and `_requestTicketSyncStatuses` folds in subtask ids only when `_isDrillDownActive(lastIntegrationProvider)` is true — which requires `_drillDownProvider === provider` (`tickets.js:761-763`). Called at line 3453 the guard is false, no subtask ids are sent, and the plan's own bug survives the fix.
> **Replaced with:** call it at the END of the `if (subs && subs.length > 0)` block, after every drill-down variable is set.

```js
        if (subs && subs.length > 0) {
            _sidebarDrillDownParentId = id;
            _drillDownSubtasks = subs;
            _drillDownProvider = provider;
            _drillDownParentTitle = /* …unchanged… */;
            // AFTER _drillDownProvider — _isDrillDownActive gates on it, so a request
            // fired earlier in this block would omit every subtask id.
            _requestTicketSyncStatuses();
        }
```

### `src/webview/tickets.html` — pending badge styling (beside `.ticket-sync-local`, lines 3072-3075)

```css
        .ticket-sync-pending {
            color: var(--text-secondary);
            opacity: 0.5;
        }
```

Matching the shape of the three existing modifiers so it inherits `.ticket-sync-badge`'s box; a lower opacity than `.ticket-sync-local`'s `0.7` so a transient state reads as less assertive than a verdict.

## Verification Plan

### Automated Tests
1. `npm run test:contract:tickets-sidebar-scoping` (`src/test/tickets-sidebar-list-scoping.test.js`) — must stay green; the request payload keeps its shape (`{ provider, ids, listId/projectId }`), only the `ids` contents widen. *(The original plan named this script `test:contract:tickets-sidebar-list-scoping`, which does not exist — `package.json:838` defines `test:contract:tickets-sidebar-scoping`.)*
2. `npm run test:contract:verb-engine-tickets` — the `getTicketSyncStatuses` arm is unchanged server-side; must stay green.
3. Add source assertions in a tickets test: `_ticketSyncBadge` must contain a `'local-only'` comparison (proving the fallback is no longer the local branch), `_requestTicketSyncStatuses` must reference `_drillDownSubtasks`, and the `_requestTicketSyncStatuses()` call inside `_maybeEnterDrillDown` must appear *after* the `_drillDownProvider = provider` assignment.

### Manual (VSIX install)
4. Pick a parent ticket with ≥2 subtasks where at least one subtask has been imported locally and pushed (→ `synced`) and one has never been imported (→ `local`). Drill into the subtask view.
5. Expected on first paint: badges briefly read `checking`, then resolve to `synced` and `local` respectively. Before the fix all of them read `local` permanently.
6. Edit the synced subtask's local file (touch its body), wait for the watcher, re-open the drill-down. Expected: that card reads `modified`.
7. Exit drill-down to the top-level list. Expected: badges resolve to their real values as before — but note they now show `checking` during the in-flight window instead of `local`. That is the intended change, not a regression.
8. **Status survives a list reload.** With badges resolved, trigger a local-file reload (import a ticket, or touch a ticket file to fire the watcher). Expected: resolved badges stay resolved — they do not flip back to `checking` and stick.
9. With the sidebar search filter set so the top-level list is empty, drill into a parent. Expected: subtask badges still resolve — this is the case the old `if (!issues.length) return;` guard silently skipped.
10. **Cross-panel scope.** Open two tickets panels on different lists, drill into a parent in one. Expected: only that panel's badges update; `_isForThisPanel` still filters the broadcast.
11. **Browser cockpit.** Repeat steps 4-6 against the standalone server.

## Recommendation

Complexity 4 → **Send to Coder.**

## Review Findings

Reviewed as implemented; no code defects found. All five changes are present and correct: the four-way `_ticketSyncBadge`, the union-guarded id list folding `_drillDownSubtasks`, the drill-down splice in `ticketSyncStatusesLoaded`, the `prevSync` carry-forward plus re-request in `localTicketFilesListed`, and the `_requestTicketSyncStatuses()` call placed *after* `_drillDownProvider = provider` (verified by ordering, not just presence). Traced for loops and double-triggers: `ticketSyncStatusesLoaded` only re-renders, `renderTicketsTab` never calls `loadLocalTicketFiles`, so the new re-request cannot recurse; the pre-existing `_requestTicketSyncStatuses(); loadLocalTicketFiles();` pairs now fire a second, idempotent request per load — accepted, not a defect. Gap fixed: plan verification #3's source assertions did not exist, so every one of these five could be undone silently; four assertions (12–15) were added to `src/test/tickets-sidebar-list-scoping.test.js`, which CI already invokes (`integration-tests.yml:272`), including the call-ordering pin and a negative assertion against the bare `syncStatus: t.syncStatus` rebuild. Remaining risk: a genuine backend failure still leaves a permanently-stuck `checking` chip, which the plan accepted as the honest report.
