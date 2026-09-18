# Tickets Tab Does Not Auto-Refresh Tickets on Agent Updates

## Goal

When an agent edits a ticket's local markdown file, the Tickets tab sidebar does not
refresh to show the change. The user must click "Refresh" to see it. Make local `.md`
edits — including creates and deletes — appear in the sidebar without user action.

> **Superseded:** the original Goal — *"When an agent (or any remote process) updates a
> ticket **in ClickUp or Linear**, the Tickets tab … does not automatically refresh"* —
> and the Background Context that framed the gap as *"did not port the auto-sync
> infrastructure that **polls the remote API**"*.
> **Reason:** wrong scenario. Confirmed with the user on 2026-08-07: "agent updates"
> means **an agent editing the local `.md`**. Changes made in the ClickUp/Linear web UI
> are handled by the Refresh button, and no bug was ever reported there. The Tickets
> sidebar is file-backed — it renders from local files, not from the provider API — so
> nothing about this symptom requires a network round-trip. The original framing sent
> the plan at a 45-second remote polling port across six files; the actual defect is four
> local wiring faults in two files, none of which touch ClickUp or Linear.
> **Replaced with:** the Goal above, and the root-cause analysis below.

### Root Cause

Every local-refresh mechanism in the Tickets panel is unarmed, dead, or scoped to the
selected ticket only. Four independent faults, each sufficient on its own to produce the
symptom:

**1. The file poll is dead code.** `_startTicketsFilePoll()` (`tickets.js:3406-3412`) has
**zero callers** — verified by grep across the repo. Its teardown is wired
(`_stopTicketsFilePoll` at `tickets.js:4143`, `:7841`, `:7842`), which is what disguises
it as live. Even if it ran, its body calls `_refreshSelectedTicketFromFile()` — the
**selected** ticket only, never the sidebar list.

**2. The backend file watcher is usually never armed.** `_setupTicketsViewWatcher`
(`TicketsPanelProvider.ts:494`) is reached from two verbs:
- `setupTicketsWatcher` (`ts:1366-1370`) — sent from `restoreTicketsState()`
  (`tickets.js:4322-4325`), **once**, gated `if (ticketsWorkspaceRoot)`.
- `ticketsRootChanged` (`ts:1411-1447`) — **dead**; `tickets.js` never sends it. The only
  senders repo-wide are `planning.js:4218` and `:4230`, the legacy planning-hosted
  tickets tab, whose messages route to `PlanningPanelProvider`.

`restoreTicketsState()` is called once during init (`tickets.js:5737`). At that moment
`ticketsWorkspaceRoot` is only populated from webview-local persisted state
(`tickets.js:7836-7838`). On a first open — or any session where that state is absent —
the root is `''`, so `setupTicketsWatcher` is **never sent** and the watcher is never
armed for the whole session. The root *is* resolved moments later by `rootsFetched` →
`ensureTicketsRootDefault()` (`tickets.js:415-419`, `:6589`), `restoredTabState`
(`:6601`), and `ticketsDefaultRoot` (`:6646`) — but **none of those re-send
`setupTicketsWatcher`**. The watcher's arming is permanently one step behind the root it
needs.

**3. Even when armed, the sidebar never re-renders.** The `ticketFileChanged` arm
(`tickets.js:7368-7420`) branches on whether the changed ticket is the currently-selected
one:
- Selected → updates the detail pane and calls `renderTicketsTab()` (`:7392-7394`).
- **Not selected → writes the in-memory detail cache and stops** (`:7401-7418`). It never
  calls `loadLocalTicketFiles()`, so the sidebar list is not re-rendered and the card's
  title stays stale until a manual Refresh.

The comment at `:7396` — *"Always update cache so next click shows fresh content"* —
states the intent plainly: the cache is refreshed for the **next click**, not for the
current view. That is the bug in one line.

**4. Creates and deletes are swallowed.** The watcher callback
(`TicketsPanelProvider.ts:541-544`) filters only on `.md` and does **not** branch on the
event type, then calls `handleTicketFileEvent`, which does `readFileSync` inside a `try`
with an empty `catch` (`ts:522-535`). Consequences:
- **Delete** → `readFileSync` throws → swallowed → no message posted → the card lingers.
- **Create** → the read succeeds and `ticketFileChanged` is posted, but the frontend arm
  (fault 3) only touches the cache for a non-selected ticket → the new card never
  appears.

Note the auto-sync watcher in `PlanningPanelProvider` *does* filter (`if (event !==
'change' …)`, `ts:7170`); the extracted display watcher dropped the filter without adding
delete handling, leaving it to fail silently instead.

## Metadata

**Complexity:** 4
**Tags:** frontend, backend, bugfix, ui, ux
**Project:** Browser Switchboard

## User Review Required

- None.

## Complexity Audit

### Routine

- Re-sending `setupTicketsWatcher` once the workspace root resolves — one call at each of
  the three sites that set the root, or one shared helper called from all three.
- Adding a `loadLocalTicketFiles()` call to the non-selected branch of
  `ticketFileChanged`.
- Deleting the dead `_startTicketsFilePoll` function and its teardown wiring, or wiring it
  up — see the design decision in Proposed Changes.
- No backend network calls, no new verbs, no schema or catalog changes, no provider API
  involvement of any kind.

### Complex / Risky

- **Refresh amplification.** `loadLocalTicketFiles()` issues a `listLocalTicketFiles`
  round-trip. An agent rewriting 30 ticket files fires 30 watcher events; naively calling
  it per event produces 30 full list reloads and a visibly thrashing sidebar. A debounce
  is mandatory, not optional.
- **Watcher arming is idempotency-sensitive.** `_setupTicketsViewWatcher` **disposes and
  rebuilds** on every call (`ts:495-500`) — unlike the auto-sync watcher, it has no
  `if (existing) return` guard. Calling it from three root-resolution sites that can all
  fire in one startup means three teardown/rebuild cycles. Harmless but wasteful, and it
  briefly leaves no watcher in place; guard on "root actually changed".

## Edge-Case & Dependency Audit

### Race Conditions

- **Watcher arming vs. first agent edit.** If an agent writes a file in the window between
  panel open and root resolution, the event is lost — there is no replay. Acceptable: the
  initial `loadLocalTicketFiles()` on source load covers it, because the sidebar is built
  from a fresh directory read at that point.
- **Debounced reload vs. in-flight reload.** Two watcher bursts within the debounce window
  must collapse to one reload, and a reload already in flight must not be cancelled by a
  later one — `loadLocalTicketFiles` is a request/response pair with no in-flight guard.
  Trailing-edge debounce handles both.
- **Rebuild while events are queued.** Re-arming the watcher disposes the old handle;
  events already queued against it are dropped. Guarding on "root changed" keeps rebuilds
  rare enough that this cannot bite in practice.

### Security

- None. No new network surface, no new verb, no untrusted input. `listLocalTicketFiles`
  and `setupTicketsWatcher` are existing verbs with existing schemas, called with the same
  payloads they already receive.

### Side Effects

- The sidebar will re-render on external file changes where it previously did not. That is
  the entire point, but it means a user mid-scroll or mid-selection sees the list rebuild.
  Confirm `loadLocalTicketFiles` preserves the current selection and scroll position; if
  it does not, that is in scope for this plan — a refresh that loses the user's place is a
  different bug traded for this one.
- Deleting the currently-selected ticket must clear the detail pane rather than leave it
  showing a file that no longer exists.

### Dependencies & Conflicts

- **No external dependencies.** No provider API, no new packages, no backend services.
- **Gates unaffected:** no verb surface change, so `npm run catalog:check`,
  `parity:check`, and `verb-returns:check` (Tickets ceiling 56) are untouched.
  `push-routing:check` — Change 2 adds no raw `postMessage`; it calls an existing helper.
- **Conflicts:** `tickets.js` is also edited by the source-nav-arrows plan
  (`feature_plan_20260806161531`) and the diagram-prompt plan
  (`feature_plan_20260806153020`). Different regions, same file — per PRD orchestration
  discipline, one agent stream per file; serialise.
- **Shared across hosts:** `tickets.js` is served to both the extension host and the
  standalone `npx` host via `headlessPanelHtml.ts`, so the frontend fixes land in both
  from one edit. The watcher itself is backend and runs in whichever host constructed the
  provider.

## Dependencies

- None. No prior session work is required; no `sess_*` prerequisites.

## Adversarial Synthesis

**Risk Summary.** The diagnosis is four independent local faults, any one of which alone
explains the symptom — so a partial fix will look like no fix at all, and the tempting
single-line change (add `loadLocalTicketFiles()` to the `ticketFileChanged` arm) does
nothing whatsoever on a session where the watcher was never armed. The main implementation
risk is refresh amplification: an agent rewriting many files at once turns one-reload-per-
event into a thrashing sidebar, so the debounce is load-bearing rather than a nicety.
Secondary risk is that a full sidebar reload discards selection and scroll position,
trading a staleness bug for a usability one. Mitigations: fix all four faults together,
verify with the watcher confirmed armed, debounce on the trailing edge, and assert
selection survives the reload.

## Proposed Changes

### 1. `src/webview/tickets.js` — arm the watcher whenever the root resolves

**Context:** `restoreTicketsState()` (`:4322-4331`) is the only sender of
`setupTicketsWatcher`, runs once, and is gated on a root that is usually still empty.

Extract the send into a helper and call it from every site that establishes the root:

```js
// The backend watcher is armed per-root. Every path that resolves or changes
// ticketsWorkspaceRoot must (re-)arm it — restoreTicketsState alone runs before
// the root exists, which left the watcher unarmed for the whole session.
let _armedTicketsWatcherRoot = '';
function ensureTicketsWatcherArmed() {
    if (!ticketsWorkspaceRoot) { return; }
    if (_armedTicketsWatcherRoot === ticketsWorkspaceRoot) { return; }  // already armed
    _armedTicketsWatcherRoot = ticketsWorkspaceRoot;
    vscode.postMessage({ type: 'setupTicketsWatcher', workspaceRoot: ticketsWorkspaceRoot });
}
```

Call it from:
- `restoreTicketsState()` (`:4323-4325`) — replace the inline `postMessage`.
- `ensureTicketsRootDefault()` (`:415-419`), after `persistTicketsRoot()`.
- the `restoredTabState` arm (`:6601`), after `ticketsWorkspaceRoot = restoredRoot`.
- the `ticketsDefaultRoot` arm (`:6646`), after `ticketsWorkspaceRoot = message.workspaceRoot || ''`.
- the `workspaceRootChanged` arm (`:6622`), after the root is adopted.

**Edge cases:** the `_armedTicketsWatcherRoot` guard is what makes calling from five sites
safe — `_setupTicketsViewWatcher` disposes and rebuilds unconditionally
(`TicketsPanelProvider.ts:495-500`), so without the guard a single startup would tear down
and rebuild the watcher up to five times.

### 2. `src/webview/tickets.js` — refresh the sidebar on any ticket file change

**Context:** `ticketFileChanged` (`:7368-7420`). The non-selected branch (`:7401-7418`)
updates the detail cache and stops.

Add a debounced sidebar reload that runs for **both** branches — a change to the selected
ticket also changes its sidebar card's title:

```js
// One reload per burst. An agent rewriting 30 ticket files fires 30 events;
// without this the sidebar reloads 30 times and visibly thrashes.
let _ticketFileChangedDebounce = null;
function _scheduleSidebarRefreshFromFiles() {
    clearTimeout(_ticketFileChangedDebounce);
    _ticketFileChangedDebounce = setTimeout(() => {
        _ticketFileChangedDebounce = null;
        loadLocalTicketFiles();
    }, 300);
}
```

Call `_scheduleSidebarRefreshFromFiles()` at the end of the `ticketFileChanged` arm,
after the existing selected/non-selected cache handling, before `break`.

**Edge cases:** 300ms matches the backend watcher's own per-file debounce
(`TicketsPanelProvider.ts:522-535`), so the two stages compose to roughly one reload per
burst rather than one per file. Clear the timer on panel teardown alongside
`_stopTicketsFilePoll` (`:7841-7842`).

### 3. `src/services/TicketsPanelProvider.ts` — handle create and delete

**Context:** the watcher callback (`ts:541-544`) does not branch on event type;
`handleTicketFileEvent` (`ts:513-536`) reads the file inside a `try`/empty-`catch`, so a
delete is silently swallowed.

Branch on the event before reading:

```typescript
const watcher = this._seams().watcher.watchFolder(folder, (event, filePath) => {
    if (!filePath.endsWith('.md')) { return; }
    if (event === 'delete') {
        const fileName = path.basename(filePath);
        const match = fileName.match(/^(linear|clickup)_([^_]+)_.*\.md$/);
        if (!match) { return; }
        const [, provider, id] = match;
        // No read — the file is gone. The webview drops the card and clears the
        // detail pane if this ticket was selected.
        this.postMessageToWebview({ type: 'ticketFileDeleted', provider, id });
        return;
    }
    handleTicketFileEvent(filePath);   // create + change both read the file
});
```

Add the matching `ticketFileDeleted` arm in `tickets.js`: drop the id from
`clickUpTaskDetailCache` / `linearIssueDetailCache`, clear `selectedClickUpIssue` /
`selectedLinearIssue` if it was the selected one, then call
`_scheduleSidebarRefreshFromFiles()`.

**Edge cases:** the seam's event vocabulary is confirmed, not assumed —
`HostWatchEvent = 'change' | 'create' | 'delete'` (`hostSeams.ts:541`), and
`VscodeHostFileWatcher.watchFolder` (`ts:553-560`) wires all three from
`onDidChange` / `onDidCreate` / `onDidDelete`. So `'delete'` is the correct string and
deletes genuinely do reach the callback today — they are lost purely in the empty `catch`,
not upstream. `'create'` correctly falls through to `handleTicketFileEvent`, which reads
the new file.

### 4. `src/webview/tickets.js` — remove the dead file poll

`_startTicketsFilePoll` (`:3406-3412`) has zero callers. With Changes 1-3 the watcher is
the refresh mechanism and a 4-second poll would be redundant.

Delete `_startTicketsFilePoll`, `_stopTicketsFilePoll`, `_ticketsFilePollTimer`, and the
three teardown call sites (`:4143`, `:7841`, `:7842`).

> **Design decision — delete rather than wire up.** The alternative is to call
> `_startTicketsFilePoll()` and rely on polling instead of the watcher. Rejected: it
> refreshes only the selected ticket (`_refreshSelectedTicketFromFile`), so it cannot fix
> faults 3 or 4 regardless; it burns a 4s interval for the life of the panel; and the
> watcher path is already built and merely mis-wired. Keeping both would mean two refresh
> mechanisms racing on the same state.

**Edge cases:** verify `_refreshSelectedTicketFromFile` has no other callers before
removing anything that would orphan it.

## Out of Scope

- **Remote auto-sync (polling ClickUp/Linear for web-UI-originated changes).** An earlier
  revision of this plan proposed porting `PlanningPanelProvider`'s 45-second delta-pull
  and auto-push system into `TicketsPanelProvider`. That addresses a *different* scenario —
  someone changing a ticket in the provider's web UI — which is served today by the Refresh
  button and for which no bug was reported. Removed from this plan.
- **Tickets auto-sync is a separate, confirmed migration regression — now covered by its
  own plan:** `feature_plan_20260807103000_tickets-autosync-migration-regression.md`.
  A shipped `setup.html` toggle wrote `ticketsAutoSync: true` to the per-folder config
  (`SetupPanelProvider.ts:1125-1132` at `a906a3eb`), that on-disk value is still read
  (`PlanningPanelProvider.ts:2154-2166`), and the engine still arms
  (`ts:2627-2628`) — but the writer was deleted and the engine never moved to
  `TicketsPanelProvider`. Affected users have silent auto-pushes with no pulls and no
  control. Unrelated to the local `.md` refresh bug this plan fixes; the two collide in
  `TicketsPanelProvider.ts` and `tickets.js`, so **serialise them**.

## Verification Plan

### Manual verification

1. **The watcher is actually armed** *(fault 2 — check this first; every other test is
   meaningless if it fails)*:
   - Clear webview state / open the Tickets panel fresh so no persisted root exists.
   - Load a ClickUp or Linear source.
   - Confirm `setupTicketsWatcher` is sent **after** the root resolves — not skipped
     because the root was empty at init.

2. **Edit a non-selected ticket** *(fault 3 — the core case)*:
   - With a list loaded, select ticket A.
   - Externally edit ticket **B**'s local `.md` (change its `# Title`).
   - Confirm B's sidebar card updates its title within ~1s, with no click.

3. **Edit the selected ticket:**
   - Externally edit ticket A's `.md` while A is selected.
   - Confirm both the detail pane **and** A's sidebar card update.

4. **Create** *(fault 4)*:
   - Drop a new `clickup_<id>_*.md` / `linear_<id>_*.md` into the watched folder.
   - Confirm a new card appears without a manual Refresh.

5. **Delete** *(fault 4)*:
   - Delete a ticket `.md` from the folder.
   - Confirm the card disappears; if it was selected, the detail pane clears rather than
     showing a phantom.

6. **Burst / amplification:**
   - Have an agent (or a script) rewrite 20+ ticket files at once.
   - Confirm the sidebar refreshes **once or twice**, not 20 times, and does not visibly
     thrash.

7. **Selection and scroll survive the refresh:**
   - Select a ticket partway down a long list, scroll, then trigger an external edit to a
     different ticket.
   - Confirm selection and scroll position are preserved.

8. **Both hosts:**
   - Repeat steps 2 and 4 over `npx switchboard`. The frontend is shared; this confirms
     the backend watcher is armed in the standalone host too.

9. **No regression to the manual path:**
   - Refresh button still works and still shows remote changes made in the ClickUp/Linear
     web UI. This plan does not touch that path.

### Automated Tests

Not run in this pass (SKIP TESTS / SKIP COMPILATION session directives). For the
implementer:

- `tsc --noEmit` for `TicketsPanelProvider.ts` (**not** `npm run compile` — per the repo
  build rule, `dist/` is unused in dev/test).
- Existing suites that must stay green: `src/test/tickets-sidebar-list-scoping.test.js`,
  `src/test/tickets-delta-sweep-gate-regression.test.js`,
  `src/test/tickets-assignee-filter-regression.test.js`.
- No gate is affected — no verb, schema, or catalog surface changes.
- Highest-value new test: assert that a `ticketFileChanged` message for a **non-selected**
  ticket triggers a `listLocalTicketFiles` request. That single assertion pins fault 3,
  which is the one most likely to silently regress.

## Recommendation

**Send to Coder** (Complexity 4).

## Review Findings

Reviewed all four fault fixes; the frontend wiring (watcher arming, debounced sidebar
reload, delete arm, scroll preservation) is correct and the sidebar is genuinely
file-backed, so the fault-3 fix works as intended. Three MAJOR issues were found and
fixed: (1) a rename is delivered as delete+create and ticket files ARE renamed on title
change, so the new delete branch dropped the card and blanked the detail pane of a live
ticket — `TicketsPanelProvider._setupTicketsViewWatcher` now debounces the delete on the
same per-file key and only posts `ticketFileDeleted` after `_findTicketFileById` confirms
no surviving `<provider>_<id>_*.md`; (2) `_setupTicketsViewWatcher` skips folders that do
not exist, so arming before the first import attached zero watchers while the webview's
root-keyed guard blocked re-arming for the session — added
`_rearmTicketsViewWatcherIfFoldersChanged`, called from the `listLocalTicketFiles` arm;
(3) the standalone host's `watcher.watchFolder` was a no-op stub, so this feature was
entirely dead in the browser host that this plan's project targets — implemented
`createStandaloneFolderWatcher` (real `fs.watch`) in `src/standalone/hostServices.ts`.
Files changed this pass: `src/services/TicketsPanelProvider.ts`,
`src/standalone/hostServices.ts`, plus the plan's named highest-value test
(`src/test/tickets-auto-refresh-on-file-change.test.js`, wired as
`test:contract:tickets-auto-refresh` in `package.json` and
`.github/workflows/integration-tests.yml`; 6 of its 7 assertions verified to fail against
pre-fix sources). Validation: `tsc --noEmit` clean for all touched files (5 pre-existing
unrelated `moduleResolution` errors elsewhere, unchanged from baseline); 18 contract tests
pass including all three the plan named; `catalog:check`, `parity:check`,
`push-routing:check`, `verb-returns:check`, `mirror:check` all green. Remaining risks:
`watchPattern`/`watchFile` in the standalone seams are still stubs (no consumer today, left
deliberately), and the manual UAT steps — burst amplification and both-host behaviour —
have not been exercised on a running host.

## Completion Report

Implemented all four faults. **Change 1** (`src/webview/tickets.js`): added `ensureTicketsWatcherArmed()` helper with an `_armedTicketsWatcherRoot` idempotency guard and wired it into every root-resolution site — `restoreTicketsState`, `ensureTicketsRootDefault`, the `restoredTabState` arm, the `ticketsDefaultRoot` arm, and the `workspaceRootChanged` arm — so the backend watcher arms whenever the root resolves instead of only once at init when the root is still empty. **Change 2** (`tickets.js`): added a 300ms trailing-edge `_scheduleSidebarRefreshFromFiles()` debounce that calls `loadLocalTicketFiles()`, invoked at the end of the `ticketFileChanged` arm for both selected and non-selected tickets, so the sidebar card list re-renders on any local `.md` edit without manual Refresh; the timer is cleared on pagehide/beforeunload. **Change 3** (`src/services/TicketsPanelProvider.ts` + `tickets.js`): the watcher callback now branches on `event === 'delete'` and posts a `ticketFileDeleted` message (no file read) instead of falling into the empty-catch swallow; a matching `ticketFileDeleted` frontend arm drops the id from both detail caches, clears the detail pane if the deleted ticket was selected, and schedules a sidebar refresh. Creates fall through to `handleTicketFileEvent` and now appear via the debounced reload. **Change 4** (`tickets.js`): removed the dead `_startTicketsFilePoll` / `_stopTicketsFilePoll` / `_ticketsFilePollTimer` and their three teardown call sites (`resetTicketsInMemoryState`, `pagehide`, `beforeunload`); `_refreshSelectedTicketFromFile` was kept since it has a live caller at the edit-exit path. Additionally added scroll-position preservation (`_applyTicketsListHtml`) to both list renderers so an auto-refresh does not snap the user back to the top — the plan flagged this as in-scope since `loadLocalTicketFiles` did not preserve scroll. Files changed: `src/webview/tickets.js`, `src/services/TicketsPanelProvider.ts`. No issues encountered; `node --check` passes on `tickets.js`. Compilation and tests skipped per session directives.

**Review pass (2026-08-07).** Independent reviewer ran the verification the coding pass
skipped — the skip note above was a record, not a directive. Typecheck and 18 contract
tests plus all five static protocol gates were executed and pass; see `## Review Findings`
above for the three MAJOR regressions found and fixed (rename-read-as-delete, the arming
guard blocking re-arm when the tickets folder did not yet exist, and the standalone host's
no-op watcher seam) and for the new `test:contract:tickets-auto-refresh` gate.
