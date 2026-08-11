# Refetch silently skips tickets, leaving stale local files armed to overwrite newer remote work

## Goal

Restore **Refetch's full-fetch behaviour** — a regression introduced on 2026-07-30 — and stop Push from replacing a remote that has moved on since our last pull. Today Refetch silently skips a subset of tickets, the sidebar preview then serves a days-old local file as if it were current, and pushing that file destroys remote work with no warning.

## Problem

`Refetch` is a full pull from ClickUp/Linear. For some tickets it does not fetch anything at all — the local `.md` file is left untouched, days behind the remote. The Tickets sidebar preview renders that stale file, so the user reads old content believing it is current. Because Push sends the local body as a **full replacement** of the remote description, the next push silently destroys every remote edit made since the file went stale.

This is a data-destruction bug, not a display bug. The stale file is indistinguishable from a current one in the UI.

### Reproduced on the live workspace (2026-08-10)

Ticket `86d3y200v` ("Daily Diary Improvement"), list `901615209243`:

```
REMOTE  date_updated 2026-08-10T02:47:36Z   markdown_description  7353 bytes
LOCAL   file mtime   2026-08-07T06:09:08Z   whole file            6315 bytes   ← 3 days stale
```

A full Refetch ran on 2026-08-10 at 04:36:53Z and rewrote **all 14 sibling files** in
`.switchboard/tickets/clickup/tech-team/q3-2026/sprint-4-108-238/` at that instant. This one file was skipped and still carries its 2026-08-07 bytes. Nothing in the UI says so.

### Root cause — a one-line regression in `eaee275a`

The conflict guard was introduced in `efefea79` (2026-06-29, "Tickets Tab: File-Backed Source of Truth + Initial-Load-Then-Delta Sync") and was **gated on `isDelta` by design**. A full import loaded no cache entries and skipped nothing:

```ts
// For delta pulls, load the cache DB entries once to check conflict
// status (file mtime > last_synced_at → locally modified → skip).
let dbTickets: any[] = [];
if (isDelta) {
    try {
        const cacheService = this._getCacheService(resolvedRoot);
        dbTickets = await cacheService.getImportedTickets();
    } catch (e) { /* ... */ }
}

for (const item of items) {
    // Conflict guard: in delta mode, skip tasks whose local file has
    // unpushed changes (syncStatus === 'modified'). A delta pull must
    // never silently overwrite local edits — route through the existing
    // conflict path instead.
    if (isDelta && item.id) {
```

That is the correct contract, and it is the behaviour users had for a month: a **delta** pull defers to local edits; a **full Refetch** is authoritative and takes the remote. "Refetch" means refetch.

`eaee275a` (2026-07-30, "Project Pin Assignment Correctness" — an unrelated change) removed both gates:

```diff
-            // For delta pulls, load the cache DB entries once to check conflict
-            // status (file mtime > last_synced_at → locally modified → skip).
+            // Load the cache DB entries once to check conflict status (file mtime > last_synced_at → locally modified → skip).
             let dbTickets: any[] = [];
-            if (isDelta) {
-                try {
-                    const cacheService = this._getCacheService(resolvedRoot);
-                    dbTickets = await cacheService.getImportedTickets();
-                } catch (e) { /* ... */ }
+            try {
+                const cacheService = this._getCacheService(resolvedRoot);
+                dbTickets = await cacheService.getImportedTickets();
+            } catch (e) { /* ... */ }
             }

             for (const item of items) {
-                // Conflict guard: in delta mode, skip tasks whose local file has
-                // unpushed changes (syncStatus === 'modified'). A delta pull must
-                // never silently overwrite local edits — route through the existing
-                // conflict path instead.
-                if (isDelta && item.id) {
+                // Conflict guard: skip tasks whose local file has unpushed changes
+                // (syncStatus === 'modified'). A import/pull must never silently
+                // overwrite local edits — route through the existing conflict path instead.
+                if (item.id) {
```

The comment was rewritten from "a delta pull must never…" to "a import/pull must never…" — the widening was deliberate in the edit but nothing in that commit's stated purpose (project pin assignment) called for it, and it had no test. `refreshTicketsDelta` still turns the Refetch button's `forceFull: true` into a full pull (`TicketsPanelProvider.ts:1838-1846`), but with the gate gone the guard runs identically on it, so **a full refetch can no longer re-pull any flagged ticket, by construction**.

Current state of the regressed code: `src/services/TaskViewerProvider.ts:22864-22893`.

### Why the skip is permanent, not deferred

Two mechanisms latch it shut:

1. **The delta cursor advances anyway.** `refreshTicketsDelta` sets `last_delta_pull_*` to `nowIso` on any successful result, regardless of `skippedModified` (`TicketsPanelProvider.ts:1862-1865`). A skipped ticket's remote changes fall permanently behind the cursor, so no future *delta* pull will include it in `items` again.
2. **The full pull is now blocked too** (the regression above). So the one path that could rescue it is gone.

Before `eaee275a`, mechanism 1 existed but was harmless — Refetch was the escape hatch. The regression removed the escape hatch, which is what turned a transient skip into a three-day-old file.

### Why the ticket got flagged in the first place

Its own import flagged it. `last_synced_at` was `2026-08-07T06:08:55.364Z`; the file's mtime is `2026-08-07T06:09:08.585Z` — **13.2 seconds later**. Sync status is a bare mtime comparison with a 1-second grace (`TicketsPanelProvider.ts:392-403`):

```ts
return mtimeMs > lastSyncedMs + 1000 ? 'modified' : 'synced';
```

`_writeTaskDocument` writes the file and *then* stamps `last_synced_at`, so the stamp is normally a few ms **after** the mtime and the grace covers it. But the write path does real work in between — `_removeOrphanTicketFiles` runs a full `getImportedTickets()` query plus per-file `readdirSync`/`unlink` passes (`TaskViewerProvider.ts:22184-22200`) — and subtask enrichment can rewrite the same file later. Any of these pushes the file's final mtime past `last_synced + 1s`, and the ticket self-flags as "locally modified" without the user ever touching it.

This is a second, independent defect: it manufactures the false flag that the regressed guard then acts on. Restoring the gate makes it recoverable; fixing the stamp order stops it happening.

### Why it destroys remote work

`pushTicketEdits` (`TaskViewerProvider.ts:22066-22168`) sends the local body as a **full replacement**, with no staleness check of any kind:

```ts
await clickUp.updateTask(id, { markdown_content: descriptionToPush, ...(name ? { name } : {}) });
// Linear: await linear.updateIssueDescription(id, descriptionToPush, titleFromHeading);
```

Nothing compares the remote's `date_updated` against our `last_synced_at` before writing. For `86d3y200v` that is a 6315-byte three-day-old body overwriting a 7353-byte description edited two hours ago. The user is actively told to do this: the skip toast reads *"push or discard changes first"* (`TicketsPanelProvider.ts:1881`) — and there is no discard action in the product, so push is the only offered remedy.

**This half has never worked** — unlike the skip, it is not a regression. It matters here because three call sites reach `pushTicketEdits`, and two need no user intent:

1. `pushTicket` (`TicketsPanelProvider.ts:2722`) — the per-card Push button. Deliberate.
2. `syncAllTickets` (`TicketsPanelProvider.ts:3424-3466`) — "Sync All". Scans every ticket directory, collects **every** `.md` matching the provider, dedupes by id, pushes all of them at concurrency 4. **No sync-status filter.** On this install that is ~250 full-description overwrites in one click.
3. **The auto-sync file watcher** (`TicketsPanelProvider.ts:735-772`). With `ticketsAutoSync` on, any `change` event on a `<provider>_<id>_*.md` file schedules a push 2 seconds later. A `git checkout`, branch switch, or backup restore on a stale file pushes it over newer remote work with zero user action.

### Scope

Restoring the gate is the fix for the reported bug. The push guard is separate, additive scope — it addresses the destruction that the stale file enables, and the stale files already on disk today are still armed regardless of the gate fix.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, backend, reliability, api
- **Project:** Browser Switchboard

## User Review Required

None. One scope note, stated rather than asked: §1–§2 restore previously-shipped behaviour; §3–§5 are net-new hardening that never existed in any released version. If you want the minimum revert only, §1 alone closes the reported bug.

## Complexity Audit

### Routine

- Restoring the `isDelta` gate — a two-line revert of `eaee275a`, back to the shape that shipped in `efefea79`.
- Reordering the `last_synced_at` stamp ahead of `_removeOrphanTicketFiles`.
- Making the skip message name a remedy that exists.

### Complex / Risky

- **Restoring the gate makes full Refetch discard local edits again.** That is the original, intended contract — "Refetch" takes the remote — but it is a real behaviour change *from today's build*, and any user who has grown used to the current accidental protection will lose it.
- **`includeClosed` silently promotes Refresh to a full pull.** `const forceFull = includeClosed || !!msg.forceFull;` (`TicketsPanelProvider.ts:1839`), and the ClickUp **Refresh** button always sends `includeClosed: _clickUpIncludeClosedForRefresh()` (`tickets.js:4947`) — only Refetch sends `forceFull: true` (`:4966`). So with a closed status selected in the filter, Refresh takes the full-pull branch and, after §1, would discard local edits. Nobody expects that from a button named Refresh. **Decision: narrow the promotion.** `includeClosed` needs to bypass the *delta cursor* (a closed ticket has not changed since the cursor, so a delta pull would never return it) but it does not need to bypass the *conflict guard*. Split the two concerns:

  ```ts
  // includeClosed must bypass the delta CURSOR — a ticket closed before the
  // cursor never appears in a delta payload — but it must NOT bypass the
  // conflict guard. Only an explicit Refetch click means "discard my local
  // edits and take the remote".
  const bypassCursor = includeClosed || !!msg.forceFull;
  const authoritative = !!msg.forceFull;
  ```

  Pass `authoritative` down to `importAllTasks` and gate the conflict guard on `isDelta || !authoritative` rather than `isDelta` alone, so only the Refetch button discards local work. This keeps §1's revert intact for Refetch while leaving Refresh non-destructive at every filter setting.
- **`syncAllTickets` pushes ~250 files unconditionally.** Filtering it is the single highest-value change in the plan for preventing data loss, and it is independent of the regression.
- **No confirmation dialogs.** Per project rules, no `confirm()` / two-click gates — `window.confirm()` is a silent no-op in VS Code webviews and would make any such button do literally nothing.
- **Shipped state.** No schema change and no migration. The push guard reads columns that already exist and treats missing values as "no baseline → allow the push", never "block", so no existing install breaks.

## Edge-Case & Dependency Audit

### Race Conditions

- **Pull → watcher → echo push.** With auto-sync on, `_writeTaskDocument` rewriting a file fires the watcher's `change` event, which pushes the file back 2s later. There is no suppression anywhere in `_updateTicketsAutoSyncWatcher`. Restoring the gate makes this *louder* — previously-skipped tickets now get rewritten, so they now echo. The echo is content-neutral (we push back what we just pulled) but it bumps the remote's `date_updated`, which the push guard must tolerate (see §3's grace note).
- **45s delta timer vs. manual Refetch.** Both call `switchboard.importAllTasks` on the same root with no mutual exclusion, so run A's stamp can land after run B's write. This is a live contributor to the false-flag window and another reason to stamp immediately after `writeFileSync`.

### Security

- No new network surface, no new secrets. The push guard adds one authenticated GET per push on the already-configured client.

### Side Effects

- **Remote deleted.** `getTaskDetails` **throws** on non-200 (`ClickUpSyncService.ts:1358-1360`). The guard must use `getTaskDateUpdated` (`:2883`, a bare `GET /task/{id}`) inside an explicit try/catch, and a failed verification must cancel the push and leave the local file intact — never fall through to "no baseline, push anyway", which would recreate a deleted ticket from a stale body.
- **Missing `last_synced_at`** (local-only files, heal-scan adoptions at `TicketsPanelProvider.ts:2014`): no baseline, so the guard allows the push and says so. Local-only tickets must stay pushable.
- **Clock skew.** `last_synced_at` is written from the local clock (`KanbanDatabase.ts:3402`) while `date_updated` comes from the provider's. A skewed machine can produce a false "stale" block. Accepted rather than engineered around: with Refetch working again, a false block is fully recoverable (Refetch, then push), and the failure is loud rather than silent. Use a 60s grace, not 1s, so ordinary NTP drift and the auto-sync echo do not trip it.
- **`## Subtasks`** is import-generated and must stay excluded from the pushed description — the truncation guard in `pushTicketEdits` is covered by `src/test/tickets-subtask-embedding.test.js:50-54`. Do not regress it.
- **Delta pulls keep their guard.** The gate restoration is explicitly *not* a licence to overwrite local edits on the 45s timer.

### Dependencies & Conflicts

- **Touched files:** `TaskViewerProvider.ts`, `TicketsPanelProvider.ts`.
- No schema migration, no new dependencies, no protocol version change.
- `ClickUpSyncService.getTaskDateUpdated(taskId)` already exists (`:2883`) and returns exactly the ISO `date_updated` the guard needs.
- `LinearSyncService.getIssue(id)` (`:975`) already selects `updatedAt` (`:410`).

## Dependencies

- None.

## Adversarial Synthesis

**Risk Summary.** Key risks: (1) restoring the `isDelta` gate reinstates "full Refetch takes the remote", which is the original contract but discards local edits on an explicit Refetch — acceptable because the delta path still protects them and the button's name promises exactly this; (2) the false-flag window keeps manufacturing bogus "modified" states on the delta path until the stamp is reordered; (3) the push guard is net-new and clock-skew-sensitive, so it is tuned to fail loud-and-recoverable rather than silent. Mitigations: revert the gate to its `efefea79` shape, stamp `last_synced_at` immediately after `writeFileSync`, filter `syncAllTickets` to genuinely-modified tickets before pushing, and give the push guard a 60s grace with allow-on-no-baseline semantics.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts:22864-22893` — restore the `isDelta` gate (the regression fix)

Restore `efefea79`'s contract, keyed on an explicit Refetch rather than on `isDelta` (see the `includeClosed` note in the Complexity Audit — `isDelta` alone would let a filter toggle discard local edits). `refreshTicketsDelta` computes `authoritative = !!msg.forceFull` and threads it into `importAllTasks` alongside the existing delta params:

```ts
// Load the cache DB entries to check conflict status (file mtime >
// last_synced_at → locally modified → skip) for every pull EXCEPT an explicit
// Refetch. A Refetch is authoritative and must fetch every ticket: "Refetch"
// means refetch. This gate is not an optimisation — eaee275a dropped it as a
// drive-by in an unrelated commit and that is what left 86d3y200v three days
// stale, because the full pull is the only escape from a flagged ticket (the
// delta cursor advances past skips, so a delta pull never re-offers them).
// `authoritative` is true ONLY for an explicit Refetch click (forceFull). It is
// deliberately NOT `!isDelta`: includeClosed also forces a full pull (to bypass
// the delta cursor), and a filter toggle must not silently discard local edits.
let dbTickets: any[] = [];
if (!authoritative) {
    try {
        const cacheService = this._getCacheService(resolvedRoot);
        dbTickets = await cacheService.getImportedTickets();
    } catch (e) {
        console.warn('[TaskViewerProvider] could not load cache entries for conflict check:', e);
    }
}

for (const item of items) {
    // Conflict guard: skip tasks whose local file has unpushed changes. Only an
    // authoritative Refetch overwrites them — that is what the user asked for by
    // clicking it.
    if (!authoritative && item.id) {
```

`dbTickets` stays in scope for the prune and the orphan-subtask upsert below, which read it independently — verify both still behave when it is empty on a full pull (the prune's `dbBySlug` lookup yields `undefined`, which falls through to "not modified → prunable", matching pre-`eaee275a` behaviour).

Leave the prune's mtime guard (`:22977-22984`) exactly as-is. It protects a file from *deletion*, not from a write; its `continue` preserves user work rather than discarding remote data, so it is not an instance of this bug.

### 2. `src/services/TaskViewerProvider.ts:22457-22474` — close the false-flag window

Stamp `last_synced_at` **immediately** after `writeFileSync`, before `_removeOrphanTicketFiles`:

```ts
fs.writeFileSync(filePath, content, 'utf8');
// Stamp FIRST. _removeOrphanTicketFiles runs a full getImportedTickets() query
// and per-file readdir/unlink passes; stamping after it puts last_synced_at
// seconds behind the file's own mtime and self-flags the ticket we just
// imported — that is how 86d3y200v flagged itself 13.2s after its own import.
try {
    const cacheService = this._getCacheService(resolvedRoot);
    await cacheService.registerImportedTicket(provider, id, title, `${provider}_${id}`, filePath, '', undefined, ticketUrl);
} catch (regErr) {
    console.error('[TaskViewerProvider] failed to record sync time after bulk write:', regErr);
}
await this._removeOrphanTicketFiles(resolvedRoot, targetDir, provider, id, filename);
```

Without this, the delta path keeps manufacturing false "modified" flags; §1 only makes them recoverable.

### 3. `src/services/TaskViewerProvider.ts:22066` — block stale pushes (net-new)

In `pushTicketEdits`, before sending:

```ts
// Refuse to replace a remote that moved since our last pull. push sends the
// local body as a FULL replacement of the description — with a stale file that
// silently deletes every remote edit made since. 86d3y200v: a 3-day-old
// 6315-byte local file against a 7353-byte description edited 2 hours earlier.
//
// 60s grace, not 1s: last_synced_at is our clock, date_updated is the
// provider's, and the auto-sync watcher echo-pushes ~2s after every pull.
// A false block is recoverable (Refetch, then push); a false pass is not.
const entry = await cacheService.getImportBySlugPrefix(`${provider}_${id}`);
const baselineMs = entry?.lastSyncedAt ? Date.parse(entry.lastSyncedAt) : 0;
if (baselineMs) {
    let remoteUpdatedMs = 0;
    try {
        // getTaskDateUpdated, not getTaskDetails: one bare GET /task/{id}
        // instead of ?include_subtasks=true&include_markdown_description=true,
        // and getTaskDetails throws on non-200 (ClickUpSyncService:1358).
        remoteUpdatedMs = provider === 'clickup'
            ? Date.parse(await clickUp.getTaskDateUpdated(id))
            : Date.parse((await linear.getIssue(id))?.updatedAt || '');
    } catch (e) {
        // A 404 means the remote is gone. Never fall through to "push anyway" —
        // that recreates a deleted ticket from a stale body.
        return { success: false, error: `Could not verify remote ticket ${id} before pushing: ${e instanceof Error ? e.message : String(e)}. Push cancelled; the local file is untouched.` };
    }
    if (remoteUpdatedMs && remoteUpdatedMs > baselineMs + 60000) {
        return {
            success: false,
            stale: true,
            error: `Remote ticket ${id} changed after your last pull `
                 + `(remote ${new Date(remoteUpdatedMs).toISOString()}, local baseline ${entry!.lastSyncedAt}). `
                 + `Pushing would overwrite it. Refetch to take the remote version, then push again.`
        };
    }
}
```

On a `stale: true` result, `pushTicket` (`TicketsPanelProvider.ts:2727`) already routes the error to `showErrorMessage` — no new UI required.

### 4. `src/services/TicketsPanelProvider.ts:3424` — stop `syncAllTickets` pushing every file on disk

`syncAllTickets` reads every `.md` in every ticket directory and pushes all of them, with **no sync-status filter**. Every stale file in the tree is an overwrite. Filter before the push loop:

```ts
// Only push tickets that actually differ from what we last pulled. Pushing an
// unmodified file is not a no-op: push is a FULL description replacement, so a
// stale file overwrites newer remote work — ~250 overwrites per click here.
const dbTickets = await this._cacheService.getImportedTickets();
const bySlug = new Map(dbTickets.map((t: any) => [t.slugPrefix, t]));
const pushable = uniqueTickets.filter(t => {
    const e: any = bySlug.get(`${provider}_${t.id}`);
    if (!e) { return true; }   // never pulled — local-only, push it
    return this._ticketSyncStatusFromTimestamps(t.filePath, e.lastSyncedAt) !== 'synced';
});
```

Report the difference in `syncAllTicketsResult` (`skipped: uniqueTickets.length - pushable.length`) so "Sync All" says *"pushed 2, 248 already in sync"* rather than silently doing 250 writes. This also keeps §3's per-push GET affordable without any batching.

### 5. `src/services/TicketsPanelProvider.ts:1881` — stop advertising the data-loss path

The message fires only on the delta path now, so it should say what actually helps:

```ts
`Refreshed ${result.successCount} ticket${result.successCount !== 1 ? 's' : ''}. `
+ `${skippedModified} skipped (local file has unpushed edits). `
+ `Push them, or hit Refetch to take the remote version and discard local changes.`
```

### 6. `src/test/tickets-refetch-full-pull-regression.test.js` — new

- **The regression lock:** `importAllTasks` with `authoritative: true` writes **every** item, including one whose file mtime exceeds `last_synced + 1s`. This is the test `eaee275a` did not have.
- A delta pull (`deltaSince` set, no `forceFull`) still skips a locally-modified ticket and counts it in `skippedModified`.
- **The `includeClosed` lock:** `refreshTicketsDelta` with `includeClosed: true` and no `forceFull` bypasses the delta cursor but **still skips** a locally-modified ticket — a filter toggle must never discard local edits.
- `_writeTaskDocument` stamps `last_synced_at` before `_removeOrphanTicketFiles`.
- `pushTicketEdits` returns `stale: true` and issues **no** provider write when the remote's `date_updated` exceeds the baseline by more than the grace.
- A missing `last_synced_at` **allows** the push rather than blocking it.
- `syncAllTickets` pushes only non-`synced` tickets.

## Verification Plan

> Per this session's directives, compilation and automated-test **execution** are out of scope; the regression tests in §6 are authored as part of the change and run by the coder who implements it.

1. **Reproduce, before the fix**
   ```bash
   cd /Users/patrickvuleta/Documents/Gitlab
   sqlite3 .switchboard/kanban.db \
     "SELECT last_synced_at FROM imported_docs WHERE slug_prefix='clickup_86d3y200v';"
   stat -f "%Sm %z" -t "%Y-%m-%dT%H:%M:%SZ" \
     .switchboard/tickets/clickup/tech-team/q3-2026/sprint-4-108-238/clickup_86d3y200v_*.md
   ```
   Hit **Refetch**. File mtime and byte count do not change; siblings do. Toast reports `1 skipped`.

2. **After the fix, same ticket** — Refetch rewrites `clickup_86d3y200v_*.md`; its size moves from 6315 toward the remote's 7353-byte body, and the sidebar preview shows current remote text. No ticket is reported skipped on a full pull.

3. **Only Refetch discards local edits** — edit a ticket body locally, then:
   - wait for the 45s auto-sync tick, or hit **Refresh** → file preserved, counted as skipped;
   - set the status filter to include a closed status and hit **Refresh** again (this takes the full-pull branch via `includeClosed`) → file still preserved;
   - hit **Refetch** → file overwritten with the remote version, as the button promises.

4. **False-flag window closed** — full import of the 15-ticket list, then immediately compare each file's mtime against its `last_synced_at`:
   ```bash
   sqlite3 .switchboard/kanban.db \
     "SELECT slug_prefix, file_path, last_synced_at FROM imported_docs WHERE content_type='ticket';"
   ```
   Zero tickets read `modified` straight after their own import (today this list produces one).

5. **Push guard** — edit a ticket locally, change the same ticket in ClickUp, then Push → blocked with the stale message, and `GET /task/<id>` confirms the remote description is **unchanged**. Refetch, then Push → succeeds. Delete a ticket in ClickUp, then Push → "could not verify"; local file untouched, no task recreated.

6. **Mass-overwrite path disarmed** — with ~250 unmodified ticket files on disk, click **Sync All** → the result reports ~0 pushed / ~250 already in sync, and a network trace shows no `PUT /task/*` for the unmodified ones. With auto-sync ON, `touch` a stale ticket file (simulating a `git checkout`) → the auto-push is blocked by the staleness guard rather than silently sent.

### Automated Tests

- `src/test/tickets-refetch-full-pull-regression.test.js` (new — assertions in §6 of Proposed Changes).
- `src/test/tickets-subtask-embedding.test.js` — must still pass unchanged; it guards the `trimmed === '## Subtasks'` push truncation at `:50-54`.
- `src/test/tickets-delta-sweep-gate-regression.test.js` — must still pass; the sweep and prune paths are deliberately untouched.
- `grep -rn "confirm(" src/webview/tickets.js` returns nothing new.
- `npm test` — stash-verify the known-red baseline first before attributing any failure to this change.

### Manual

Manual verification is via the **installed VSIX only** — nothing is served from the repo's `dist/` during testing.

---

**Recommendation: Send to Coder** (Complexity 5 — the core fix is a two-line revert with a regression test; §3–§5 are contained, additive guards on three known call sites).

---

## Completion Summary

Implemented all six sections of the plan. **§1**: Restored the conflict guard gate in `importAllTasks` (TaskViewerProvider.ts) by adding an `authoritative` parameter — true only for explicit Refetch (forceFull) — and gating `dbTickets` loading + the conflict guard on `!authoritative`. Threaded `authoritative` from `refreshTicketsDelta` (TicketsPanelProvider.ts) and updated the command registration type in `extension.ts`. **§2**: Reordered `last_synced_at` stamp to precede `_removeOrphanTicketFiles` in `_writeTaskDocument`, closing the false-flag window. **§3**: Added a stale-push guard in `pushTicketEdits` — compares remote `date_updated` against `last_synced_at` with a 60s grace, blocks on stale, cancels on deleted-remote (NaN guard), allows on missing baseline. **§4**: Filtered `syncAllTickets` to only push non-synced tickets via `_ticketSyncStatusFromTimestamps`, with `skipped` count in the result. **§5**: Updated the skip warning to mention Refetch as the remedy. **§6**: Created `src/test/tickets-refetch-full-pull-regression.test.js` covering all seven assertions. Files changed: `src/services/TaskViewerProvider.ts`, `src/services/TicketsPanelProvider.ts`, `src/extension.ts`, `src/test/tickets-refetch-full-pull-regression.test.js` (new). No issues encountered; compilation and test execution skipped per session directives.
