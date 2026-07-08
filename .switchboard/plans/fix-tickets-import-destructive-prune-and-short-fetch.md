# Fix Tickets Import Wiping Remote Tickets via Destructive Prune on a Short/Stale Fetch

## Goal

Stop the Tickets tab from ending up with only a handful of local ticket files when the remote source list has many more (observed: remote ClickUp list `901615209238` "Sprint 1" has **37 tasks, 36 of them open**, but only **3 unique ticket IDs** exist on disk — each duplicated under a stale filename). "Refetch" does not recover the missing tickets; it re-runs the same destructive/no-op path and keeps them gone.

### Core problem

The non-delta ("full") document import in `TaskViewerProvider.importAllTasks` — the `importMode === 'document' && !ids` fast path (src/services/TaskViewerProvider.ts:20638) — reconciles the on-disk ticket folder against **whatever the fetch returned**, and then *deletes* every local file whose task ID is not in that fetch. When the fetch comes back short, the reconciliation deletes the legitimately-present tickets. Because the deletion is baked into the same code path the Refresh/Refetch button triggers, refetching cannot heal them (and, on a full import, can re-destroy them).

### Root-cause analysis (four composing defects)

**Defect A — destructive reconciliation trusts an untrustworthy fetch (primary, data-loss).**
Two routines run after the writes:
- The **prune** (src/services/TaskViewerProvider.ts:20794) removes any `.md` in the list directory whose ID is not in `keepIds` (top-level open tickets from *this* fetch).
- The **full-import deletion sweep** (src/services/TaskViewerProvider.ts:20848) removes any DB-tracked ticket file whose `remoteDocId` is not in `rawRemoteIds` (all IDs from *this* fetch).

Both gate only on `rawItemCount > 0` (src/services/TaskViewerProvider.ts:20794, :20848). A fetch of 3 tasks is "non-empty", so both routines happily delete the other ~33 open tickets' files. The guard was designed to stop a *zero*-result wipe; it does nothing against a *short* result. `keepIds`/`rawRemoteIds` are derived from the very fetch whose completeness is in doubt (src/services/TaskViewerProvider.ts:20737, :20741), so a short fetch produces a short keep-set and mass deletion.

**Defect B — the reconciling fetch *could* be short if served from cache (hardening, not the demonstrated active cause).**
The fetch is `clickup.getListTasks(listId, {})` (src/services/TaskViewerProvider.ts:20656). With empty options this is an `isSimpleQuery` (src/services/ClickUpSyncService.ts:1158) and is served from the task cache when present (src/services/ClickUpSyncService.ts:1162–1166).

> **Superseded:** "The import invalidates the cache once, on page 1, but that invalidation is already known to be instance-fragile — see the 'Bug 2 (double-click refresh)' comment at :20645 acknowledging that the provider's cache instance can diverge from the one being cleared. A stale or partial cached snapshot ... is returned as the 'authoritative' set and feeds Defect A."
> **Reason:** Verified against the code: within `importAllTasks` the page-1 invalidation (`this._getCacheService(resolvedRoot).invalidateTaskCache('clickup', listId)`, :20654) and the read (`clickup.getListTasks(listId, …)`, :20656) resolve to the **same** `PlanningPanelCacheService` instance — `_getClickUpService` re-injects `_getCacheService(resolvedRoot)` on every retrieval (:6467-6468), and `invalidateTaskCache('clickup', listId)` does clear the exact simple-query key `clickup:${listId}` (PlanningPanelCacheService.ts:658 matches `fullKey === 'clickup:'+listId`). The "Bug 2" comment describes divergence with the **webview's** separate cache (PlanningPanelProvider's own `_cacheService`), which the :20653-20654 invalidation was added to sidestep. So a *cache-served short fetch is not a demonstrated active cause* of the observed loss on the non-delta path.
> **Replaced with:** Cache-staleness is **not** the active bug on this path, but a *live* fetch can still come back **short** for a different, confirmed reason: the pagination loop in `getListTasks` terminates on `pageTasks.length < 100` (ClickUpSyncService.ts:1195), and ClickUp's API applies archival/trash/permission stripping *after* slicing 100 records — so it can return a short page with HTTP 200 *mid-list* (see Uncertain Assumptions → resolved by research). A client that breaks on the first short page under-fetches, producing exactly the short live set that feeds Defect A. So the fix is **two-part**: (a) route the import through a `forceRefresh` variant that never reads cache (removes the fragile invalidate-on-page-1 dance and any future instance-divergence regression), **and** (b) fix the pagination terminal condition to use the authoritative `last_page` field, not the `<100` heuristic — and derive the completeness signal from `last_page`, never from page length. The actual recurring cause of the *permanent* loss remains **Defect D** (delta never backfills), compounded by a short full import at first-open (**Defect A**, now understood to be triggerable by pagination truncation even without cache). Load-bearing fixes: A (gate + honest pagination) and D (recovery lever); the cache-bypass and C (orphans) are hardening/cleanup.

**Defect C — renamed tickets orphan their old file (the visible duplicates).**
The bulk writer `_writeTaskDocument` derives the filename from the *title* slug — `${provider}_${id}_${slug}.md` (src/services/TaskViewerProvider.ts:20587). When a ticket is renamed remotely, the writer creates a new file at the new slug and never removes the file at the old slug. The prune keys on task **ID** (`rest.split('_')[0]`, src/services/TaskViewerProvider.ts:20807), so it preserves *both* variants of a kept ID. This is why each of the 3 surviving tickets has two files (e.g. `...minoir-app-tour...` vs `...minor-app-tour...`; `...delay-redirexct...` vs `...delay-redirect...`). Independent of the data-loss bug, but part of the same import path and the same user-visible mess.

> **Superseded:** "In `_writeTaskDocument` (src/services/TaskViewerProvider.ts:~20340–20370)" and "`_writeTaskDocument` derives the filename from the title slug (src/services/TaskViewerProvider.ts:~20354)".
> **Reason:** Wrong line numbers. Lines ~20242–20378 are `importTaskAsDocument` (the *slow, per-item* importer). The bulk writer actually called by the fast path (:20777) is `_writeTaskDocument`, defined at **:20558–20606**, with the slug-filename derivation at **:20587**. Editing ~20340–20370 would patch the wrong method and leave the bulk path (the one that produced the duplicates) untouched.
> **Replaced with:** Orphan cleanup belongs in `_writeTaskDocument` at :20558–20606 (filename at :20587). **See the coverage note below** — `importTaskAsDocument` (:20355) has the *same* slug-filename-no-cleanup bug, so the cleanup should live in a shared helper called by both writers, not be duplicated into one.

**Coverage note (new):** `importTaskAsDocument` (src/services/TaskViewerProvider.ts:20242+, filename derived at :20355) is a *second* writer with the identical `${provider}_${id}_${slug}.md` pattern and no orphan removal. It is used when a single ticket is opened/imported individually (slow path, :20970-20971). A ticket renamed remotely and then opened through that path also orphans its old-slug file. Fixing only `_writeTaskDocument` leaves this latent. The orphan-cleanup logic must be a shared helper invoked by **both** writers.

**Defect D — no recovery lever: Refresh is delta-only, so a bad delete is permanent (co-primary with A).**
The Refresh/Refetch button (src/webview/planning.js:8885) posts `refreshTicketsDelta` (handler at src/services/PlanningPanelProvider.ts:5996). Once the per-list cursor `last_delta_pull_clickup_<listId>` is set — which happens after the first load — every Refresh is a **delta pull**: `date_updated_gt=<cursor>` (src/services/ClickUpSyncService.ts:1181), so it only fetches tasks *changed since the last pull*. Tickets that were wrongly deleted (or never imported because the list grew after first-open) but have not changed remotely are never in the delta response and are never re-written; the delta path also never re-adds the full set. A full import only runs on first-ever open (no cursor) or as an accidental side effect of switching the status filter to a closed status (`forceFull = includeClosed`, src/services/PlanningPanelProvider.ts:6027). There is **no deliberate user-facing "re-pull the whole list" control**. The `"Refetch"` referenced in the missing-files message (src/services/PlanningPanelProvider.ts:6588) resolves to the same delta Refresh, so it cannot heal the deletion. This is why the reported symptom persists across every Refresh.

**Naming collision (new):** The existing button is *already* labeled **"Refetch"** (src/webview/planning.html:3769, id `tickets-refresh`, tooltip "Re-fetch from source and save local copies") — yet it performs a *delta* pull, not the full re-fetch its label and tooltip promise. So the missing-files message telling users to *"Click Refetch"* (PlanningPanelProvider.ts:6588) is already misleading: today it does not import missing tickets. Any new full-re-pull control must resolve this collision rather than add a third confusingly-named button (see Approach 4).

### Non-goals / already-correct behavior (do not change)

- The closed/subtask exclusion (src/services/TaskViewerProvider.ts:20738) is **correct and not the cause** — the remote list had only 1 "done" task and no subtasks. Leave the `!_isSubtask` / `includeClosed || !_isClosed` filter alone.
- The delta-pull path (`isDelta`) already fetches a full ID-set live before its sweep (src/services/TaskViewerProvider.ts:20887–20906, via invalidate-then-`getListTasks` on the same instance) and never prunes; it is safe today. Do not touch delta semantics beyond routing its full-ID fetch through the new `forceRefresh` variant for consistency (Approach 1).
- The `rawItemCount > 0` floor stays as a secondary guard; we are adding a stronger gate above it, not removing it.

## Requirements

1. A full (non-delta) document import must **destroy local files only when it holds a trustworthy, live, complete remote set**. If the driving fetch was served from cache, errored, or is otherwise not known-complete, the import must still write/update the files it did fetch but **must skip both the prune and the deletion sweep**.
2. The authoritative reconciling fetch must be a **live, fully-paginated API fetch** — never a cache read — regardless of cache-instance wiring.
3. Renaming a ticket remotely must **overwrite the same local file**, not create a second one. Existing orphan duplicates must be cleaned up as part of the reconciliation (migration-safe), across **both** ticket writers.
4. No behavior regression for the common healthy case (list fully fetched → files reconciled down to open top-level tickets, as designed).
5. No user-facing confirmation dialogs anywhere in the path (project rule).
6. The user must have a deliberate **full re-fetch** (force-full re-pull) control that re-imports the entire selected list from live data, so a stale/short local set can always be recovered — not reachable only via first-open or a status-filter side effect (Defect D). The control's label must not contradict what it does (Naming collision above).

## Metadata

**Tags:** backend, bugfix, reliability, api, integration
**Complexity:** 7

## User Review Required

- **Button naming resolution (product call).** Two clean options, both fix the misleading "Refetch"-does-delta collision:
  - **(Recommended) Relabel:** rename the existing delta button to **"Refresh"** (it *is* a delta refresh) and make **"Refetch"** the new full, live re-pull — this matches the existing tooltip ("Re-fetch from source and save local copies") and instantly makes the missing-files message at :6588 correct. No new button.
  - **Add-a-button:** keep "Refetch" as-is (delta) and add a separate **"Hard Refetch"**. Simpler diff, but leaves the misleading label and the incorrect :6588 message in place.

  The implementer will proceed with **Relabel** unless the user prefers otherwise.
- Everything else is a decided engineering call; no further product decisions required.

## Complexity Audit

### Routine
- Adding a `forceRefresh` option to `getListTasks` and skipping the cache read when set (localized, mirrors existing option handling).
- Adding the `forceFull` branch to the `refreshTicketsDelta` handler — the `forceFull = includeClosed` precedent already exists at PlanningPanelProvider.ts:6027.
- Adding/renaming a frontend control that posts an existing message shape with one extra flag.

### Complex / Risky
- The `fetchIsAuthoritative` gate governs **irreversible deletion of user files** — a wrong condition either re-introduces the data-loss or silently stops legitimate reconciliation. Must be correct for the healthy case *and* every abort/error/short case.
- The completeness/liveness signal must reflect **actual pagination completion**, not merely "the call returned" — otherwise the gate only *appears* to protect (see Adversarial Synthesis and Uncertain Assumptions).
- Orphan cleanup unlinks files inside the writer; it must honor the existing mtime-vs-`last_synced_at` guard so an unpushed local edit to a renamed ticket is never destroyed, and must repoint the `imported_docs` cache row so the sidebar/sync-status lookups don't dangle.
- Two writers (`_writeTaskDocument`, `importTaskAsDocument`) must share one cleanup helper to avoid a half-fixed rename bug.

## Edge-Case & Dependency Audit

- **Race Conditions:** Single-threaded JS; the invalidate→read pair is synchronous-then-await with no interleaving writer, and `forceRefresh` removes the timing dependency entirely. Back-to-back imports: the second must not read the first's just-written cache as "short" — `forceRefresh` guarantees a live fetch both times. Auto-sync delta timer firing during a Hard Refetch: both go through `importAllTasks`; the last cursor write wins, and neither deletes on a non-authoritative fetch.
- **Security:** No new external input, auth, or injection surface. Filenames are already slugified; orphan-match uses a fixed `${provider}_${id}_` prefix within the resolved `targetDir` (no traversal). No new secrets.
- **Side Effects:** Extra full paginated API call on first-open and on every Hard Refetch (deliberate). Orphan cleanup deletes local files (guarded) and mutates the `imported_docs` cache. `forceRefresh` still populates the cache after fetch, so read-only callers stay warm.
- **Dependencies & Conflicts:** Relies on ClickUp v2 pagination semantics. **Confirmed by research:** page size is fixed at 100 (not configurable), `page` is zero-indexed, and the response envelope carries an authoritative `last_page` boolean — the `<100`-length heuristic is unreliable because the server strips archived/trashed/permission-filtered records after slicing, so completeness MUST key off `last_page` (with empty-page + max-page guards). `include_closed=true` (already the default) reduces short-page truncation — keep it. `order_by=updated` + `date_updated_gt` (delta only) can shift tasks across pages mid-fetch (drift → dup/miss); `_dedupeTasks` covers dups, and the delta *sweep's* full-ID fetch uses empty options (no `order_by`), so the deletion-driving fetch is unaffected. Linear parity: the full import already uses `queryIssues({projectScoped:true})` which is uncached (`isSimpleQuery=false`, LinearSyncService.ts:743) and paginates up to `maxPages=40` × 50 = 2000 issues (LinearSyncService.ts:799-801); apply the same `fetchIsAuthoritative` gate for symmetry, and treat a `maxPages`-capped fetch as **not** authoritative.

## Dependencies

- None. (No `sess_` cross-plan dependencies; all changes are within this repo's three services + one webview file.)

## Adversarial Synthesis

**Risk Summary:** The dangerous surface is the `fetchIsAuthoritative` gate governing irreversible file deletion — it must be true in the healthy full-fetch case and false for every abort/error/short/cap case, and its completeness input must be derived from ClickUp's authoritative `last_page` field (never from `tasks.length < 100`, which the server can return short mid-list — the confirmed under-fetch that makes a short *live* fetch realistic), or the gate only appears to protect. Secondary risks: patching only one of the two slug-filename writers leaves the rename bug half-fixed, and a new full-pull button that collides with the existing (mislabeled) "Refetch" confuses users and leaves the :6588 message wrong. Mitigations: fix pagination to terminate on `last_page` with empty-page + max-page guards and derive `complete` from it (never a constant), route both writers through one orphan-cleanup helper, and resolve the button label rather than add a third.

## Proposed Changes

### src/services/ClickUpSyncService.ts

**Context:** `getListTasks(listId, options)` (:1134) is the shared ClickUp list fetch. Empty-options calls are `isSimpleQuery` (:1158) and read/write the 5-minute LRU task cache (:1162-1166, :1205-1218). The pagination loop (:1178-1200) starts at `page = 0` (:1176), throws on any non-200 (:1187), and **breaks when a page returns `< 100` tasks (:1195) — this is a latent under-fetch bug.** ClickUp slices 100 records per page (page size is fixed and not configurable) but applies archival/trash/permission filtering *after* the slice, so a short page can arrive with HTTP 200 *before* the true end of the list. The current default already passes `include_closed=true` (`includeClosed = options.includeClosed !== false`, :1174), which stabilizes page density — keep it.

**Logic:** Give callers an explicit way to (a) bypass the cache read and (b) know the returned set is a freshly-paginated, **truly complete**, live API result — and fix the pagination terminal condition itself so both `getListTasks` and the live variant stop under-fetching.

**Implementation:**
- **Fix pagination termination (all callers benefit).** Replace the `pageTasks.length < 100` break (:1195) with the authoritative response field: continue while `result.data?.last_page === false`, and stop when `last_page === true`. Add two guards against the known `last_page`-never-flips / empty-page anomaly: break if a page returns an empty `tasks` array, and keep a hard max-page safety cap (e.g. 100 pages) to prevent an infinite loop. `_dedupeTasks` (:1202) already absorbs the cross-page duplicates that `order_by`/delta drift can introduce — keep it.
- Add `forceRefresh?: boolean` to the options type (:1134-1142). When true, skip the cache-read block (:1162-1172) but still write the cache after a successful fetch (:1205-1218).
- Add a thin live variant, e.g. `getListTasksLive(listId): Promise<{ tasks: ClickUpTask[]; complete: boolean }>`, that calls the paginating fetch with `forceRefresh: true` and returns `complete: true` **only when the loop terminated because `last_page === true`** — NOT on the empty-page guard, NOT on the max-page cap, and never derived from page length. Any non-200 already throws (:1187), so a thrown call never yields `complete: true`. Do **not** hardcode `complete: true` — a future refactor must not be able to silently lie to the deletion gate.
- The existing public `getListTasks` signature is unchanged for the many read-only callers; only its terminal condition is corrected.

**Edge Cases:** >100 tasks (multi-page): `complete` requires `last_page === true`; a fetch aborted mid-pagination throws → no `complete`. A list whose backend strips records mid-page no longer terminates early. Cache write still runs on success so warm reads keep working.

### src/services/TaskViewerProvider.ts

**Context:** Fast-path document import at :20638. Non-delta branch fetches at :20656; page-1 cache invalidation at :20653-20654; `rawItemCount`/`rawRemoteIds`/`keepIds` computed :20728-20741; prune at :20794; full deletion sweep at :20848; delta sweep at :20887-20936. Bulk writer `_writeTaskDocument` at :20558-20606 (filename :20587). Per-item writer `importTaskAsDocument` at :20242+ (filename :20355). Linear full import at :20677 (uncached, paginated).

**Logic:**
1. **Live authoritative fetch (Defect B hardening).** In the non-delta ClickUp branch, replace the invalidate-on-page-1 dance + `getListTasks(listId, {})` (:20653-20656) with the `getListTasksLive(listId)` variant; capture `fetchComplete = result.complete`. For consistency, route the delta sweep's full-ID fetch (:20894) through the same `forceRefresh` variant.
2. **Gate destruction on completeness, not non-emptiness (Defect A — the load-bearing fix).** Compute one boolean `fetchIsAuthoritative = fetchComplete && !resolutionFailed && rawItemCount > 0` and require it for **both** the prune (:20794) and the full deletion sweep (:20848). When false: perform writes, skip all deletions. Keep `rawItemCount > 0` inside the gate as the empty-fetch floor. For Linear, derive `fetchComplete` from `queryIssues` not hitting the `maxPages` cap (treat a capped result as not authoritative).
3. **Stable filename + orphan cleanup, shared helper (Defect C + coverage note).** Add a private helper `_removeOrphanTicketFiles(targetDir, provider, id, keepFilename)` that scans `targetDir` for files matching `${provider}_${id}_` with a *different* slug than `keepFilename`, and for each: apply the same mtime-vs-`last_synced_at` guard used by the prune (:20813-20818) — skip if locally modified — otherwise unlink and repoint/delete the `imported_docs` cache row so no entry dangles. Call this helper from **both** `_writeTaskDocument` (after the write at :20589) **and** `importTaskAsDocument` (after its write at :20358). Net: one file per ticket ID, always reflecting the current title; existing duplicates self-heal on the next successful import — no separate migration script.

**Implementation:** Introduce `fetchComplete` alongside `rawItemCount` (:20724-20728). Change the two gate conditions at :20794 and :20848 from `rawItemCount > 0 && !resolutionFailed` to `fetchIsAuthoritative`. Add the shared helper near `_writeTaskDocument`; invoke from both writers. Simplify the now-redundant :20653-20654 invalidation (superseded by `forceRefresh`).

**Edge Cases:**
- Transient API error mid-import: live fetch throws → outer try/catch → gate false → no destruction; files intact.
- List genuinely emptied remotely: `complete && rawItemCount === 0` → gate false (floor), so a full import does not auto-wipe; the delta sweep handles the truly-empty case explicitly (:20909-20910).
- Rename + local edit simultaneously: orphan cleanup respects the mtime guard and keeps the edited old file; the conflict path surfaces it.
- Linear >2000 issues: `maxPages` cap hit → `fetchComplete=false` → no prune/sweep.

### src/services/PlanningPanelProvider.ts

**Context:** `refreshTicketsDelta` handler at :5996; `forceFull = includeClosed` precedent at :6027; cursor logic :6028-6034; delegates to `switchboard.importAllTasks` :6036-6048; cursor reset :6057-6060. Missing-files message at :6588.

**Logic:** Honor an explicit `forceFull` flag so the full-pull control bypasses the delta cursor and runs a full (non-delta) `importAllTasks`, then resets the cursor to "now". This is **safe only after** the Defect A gate lands (Approach 2) — a full import today runs the prune, so a force-full on a short live fetch could still wipe files; with the gate, a full import writes-and-reconciles only on a complete live set.

**Implementation:** Change `const forceFull = includeClosed;` (:6027) to `const forceFull = includeClosed || !!msg.forceFull;`. The existing `!forceFull` cursor-skip (:6029) and full-import delegation then apply unchanged. If the Relabel option is chosen for the button, update the missing-files copy at :6588 (the text can stay "Refetch" — with Relabel, Refetch now *is* the full pull that imports missing tickets, so the message becomes correct).

**Edge Cases:** No confirm dialog (project rule) — the action is non-destructive by construction once the gate is in place.

### src/webview/planning.js and src/webview/planning.html

**Context:** The `tickets-refresh` button (planning.html:3769, tooltip "Re-fetch from source and save local copies") is wired at planning.js:8885 to post `refreshTicketsDelta` with no `forceFull`. The status-filter change posts `refreshTicketsDelta` with `includeClosed:true` (planning.js:10464-10475).

**Logic (Recommended: Relabel):** Rename the existing button to **"Refresh"** (delta) and add/relabel a **"Refetch"** control that posts `refreshTicketsDelta` with `forceFull: true` for the current provider/list/project. This aligns the label + tooltip with behavior and makes the :6588 message correct. (Add-a-button fallback: leave "Refetch" as delta and add a distinct "Hard Refetch" posting `forceFull: true`.)

**Implementation:** In the click handler(s) at :8885, add `forceFull: true` to the `refreshTicketsDelta` payload for the full-pull control (both linear and clickup branches). Update the button label/id/tooltip in planning.html:3769 per the chosen option. No confirm dialog.

**Edge Cases:** Full pull with no list/project selected falls back to the existing `loadClickUpSpaces()` / `loadLinearProject(true)` path, same as the current button.

## Verification Plan

> Session directive: **SKIP COMPILATION** and **SKIP TESTS** for this planning pass — do not run `npm run compile` or the test suite as part of verifying this plan. The cases below remain the deliverable test spec for the implementer.

### Automated Tests
- **Regression (the exact 33-ticket loss):** seed a list dir with N files; run a non-delta document import where the mocked fetch returns a **short but non-empty** set with `complete=false` → assert **no files deleted** (gate blocks prune + sweep) and the fetched files are still written/updated.
- **Healthy full import:** mocked live fetch returns the full set with `complete=true` → files reconcile to open top-level tickets; closed/subtasks pruned as designed (no regression, Requirement 4).
- **Rename (bulk path):** import ID with title A, then re-import same ID with title B via `_writeTaskDocument` → exactly one file for that ID, named for B, old-slug file gone, cache row repointed.
- **Rename (single-ticket path):** same assertion via `importTaskAsDocument` → confirms the shared helper covers both writers (coverage note).
- **Rename + local edit:** old-slug file mtime > `last_synced_at` → preserved, not unlinked.
- **Cache:** two back-to-back imports → second uses the live (`forceRefresh`) fetch, no stale-cache short set; full set both times.
- **Full re-fetch recovery (Defect D):** seed a list dir reduced to 3 files with a delta cursor set, then trigger the full-pull control (`forceFull:true`) → assert the delta cursor is ignored, a full live import runs, and all remote open tickets are restored to disk — the recovery the delta Refresh cannot perform.
- **Linear parity:** mocked `queryIssues` short-because-`maxPages`-capped → `fetchComplete=false` → no prune/sweep.

## Uncertain Assumptions

The ClickUp pagination contract that the safety gate depends on was **researched and resolved** (no further research needed):

- **Resolved:** Page size is fixed at 100 and not configurable; `page` is zero-indexed. The `tasks.length < 100` heuristic is **unreliable** — ClickUp strips archived/trashed/permission-filtered tasks *after* slicing 100 records, so a short page can arrive with HTTP 200 mid-list. The response envelope exposes an authoritative **`last_page`** boolean, which is the correct terminal signal. There is no `total_count`/`has_more`. `last_page` can occasionally fail to flip (returning empty pages with `last_page:false`), so termination must combine `last_page===true` with an empty-page break and a max-page cap. `include_closed=true` reduces truncation; `order_by`/`date_updated_gt` introduce cross-page drift (dup/miss). These findings are already baked into Approach 1 and the Edge-Case audit above.
- **Residual (worth a 2-minute sanity check during implementation, not full research):** confirm that `last_page` is actually present on the parsed body at `result.data.last_page` for this workspace's API responses (community reports note occasional misbehavior). The empty-page + max-page guards make this fail-safe (a missing/false `last_page` yields `complete:false` → no deletion), so a wrong assumption here degrades to "skips reconciliation," never "deletes data."

Everything else in this plan was verified directly against the current source.

---

**Recommendation:** Complexity 7 → **Send to Lead Coder.**

## Completion Report

Implemented reliable ticket import logic to prevent data loss.
Modified `ClickUpSyncService.ts` to query `last_page` instead of using length heuristic and added cache bypass options.
Updated `TaskViewerProvider.ts` to gate prunes and sweeps on complete fetches only, and added orphan cleanup to eliminate duplicates.
Updated `PlanningPanelProvider.ts` and UI files to add a dedicated full Refetch button alongside the existing Refresh button.
No issues encountered during implementation.
