# Download Subtasks With Their Parents on Every Fetch

## Goal

Fetch must write a local `.md` file for every subtask it downloads, at fetch time, alongside its parent. A subtask is a ticket. Fetching tickets means fetching subtasks.

Today it writes files for top-level tickets only. Subtasks exist locally as nothing but a checklist line inside the parent's `## Subtasks` block, so clicking one raises `Action failed: readLocalTicketFile`, then blocks on a live API call, and there is no local file to edit, diff, or push.

### The problem

The subtask data is **already downloaded on every fetch**. It is then deliberately discarded before anything is written.

> **Line numbers below were re-verified against HEAD on 2026-08-13.** An earlier draft of this plan cited a file that has since shifted by ~75 lines; every anchor here is current. If they drift again, key on the symbol names, which are stable.

- ClickUp's list pull requests it: `/list/${normalizedListId}/task?page=${page}&subtasks=true&include_closed=true&include_markdown_description=true` (`ClickUpSyncService.ts:855`). `_normalizeClickUpTask` (758) maps `parentId` from `raw.parent` (766) and `markdownDescription` from `raw.markdown_description`, falling back to `raw.description` (762). Linear maps `parentId` from `raw.parent?.id` (`LinearSyncService.ts:412`).
- `importAllTasks` groups them into `subtasksByParent` (`TaskViewerProvider.ts:23862-23871`) — so they are in memory, with whatever description the payload carried.
- Then `TaskViewerProvider.ts:23887` drops them on the floor:

```ts
const _isSubtask = (it: any): boolean => !!it?.parentId;
...
items = items.filter(it => !_isSubtask(it) && (includeClosed || !_isClosed(it)));
```

Only `items` reaches the write loop at 23912-23947. Subtasks reach `_writeTaskDocument` (23403) **only as the 5th `subtasks` argument** (23939-23940) — i.e. as checklist lines for the parent's `## Subtasks` section, never as tickets in their own right. No subtask file is ever created.

The comment above the filter (23845-23851) justifies this as "what keeps a ~15-ticket list from ballooning into hundreds of files." That rationale is being rejected. The files are the product. The user has asked for subtasks to be downloaded with their parents. Delete that comment as part of this change — leaving it in place preserves a written justification for the behaviour being removed, which is how a later "cleanup" reinstates the filter.

**Second, compounding defect — the prune actively deletes them.** `keepIds` (23890) is built from the *already-filtered* `items`, and the cleanup prune at 24008-24044 removes every file in the directory whose id is not in that set (the test is `if (!taskId || keepIds.has(taskId)) { continue; }` at 24021). So even a subtask file created by some other path is destroyed on the next full refresh. Fixing the write without fixing the keep-set produces a bug that only appears one refresh later.

### Third defect — clicking a subtask downloads nothing either

There is no second path that saves a subtask. `src/webview/tickets.js:5546-5555` posts `readLocalTicketFile` (which misses) and then `clickupLoadTaskDetails`. That handler — `TicketsPanelProvider.ts:2542-2579`, and the Linear twin at 2447 — calls `getTaskDetails`, maps the result, and posts it to the webview. That is the entire handler: **no `importTaskAsDocument`, no `registerImportedTicket`, no file write.** The subtask renders from memory, is cached with `detailsFetched: true` (`tickets.js:7581`, `:7614`) so a second click does not even re-request it, and is gone on panel reload. At no point does a subtask exist on disk.

So the count is not "fetch skips them, click covers it." Nothing covers it.

### `importTicketSubtasks` is not a fourth path — it is intentionally unwired

`TicketsPanelProvider.ts:3031` handles an `importTicketSubtasks` verb whose stated purpose is subtask persistence. **Nothing in `src/webview/` posts it** — a repo-wide grep for senders returns zero, and its tests assert only its internals (the `registerImportedTicket` restamp, `tickets-subtask-embedding.test.js:350-364`) and its allowlist membership, never that anything invokes it.

That is deliberate, not rot. `feature_plan_20260806110532_audit-the-planning-to-tickets-panel-extraction.md:40` records it as a fix: *"Defect 4 — FIXED: `tickets.js` no longer posts `importTicketSubtasks`."* The reason is `feature_plan_20260806110210_tickets-import-generated-subtasks-block-leaks-into-the-ticket-body.md` — posting it on every ticket open wrote the generated `## Subtasks` block into the parent's body, and that block leaked into the remote on push. Removing the caller was the remedy.

It is also still **live over HTTP**: `POST /tickets/verb/importTicketSubtasks` reaches `LocalApiServer.ts:3906` → `handleServiceVerb` (`:144-155`, gated on `TICKETS_VERBS`, which contains it) → the handler. External agents and the browser cockpit can call it today.

Two consequences for this plan, both hard constraints:

- **Do not re-wire it.** It would reintroduce the body-leak bug it was cut to fix, and it creates no subtask files anyway — it re-imports the **parent** with `includeSubtasks: true`, which only appends the parent's checklist.
- **Do not delete it.** It is reachable API surface, not dead code. Removing it from the allowlist and `protocol-catalog.json` is a breaking change to the external contract and has no place in a bugfix.

Leave it exactly as it is.

### Downstream symptom (this is a consequence, not the bug)

`src/webview/tickets.js:5536-5556` is local-file-first for every card — selecting a ticket always posts `readLocalTicketFile` ("the local `.md` is the source of truth for the description"), rendering any cached snapshot first for responsiveness. `readLocalTicketFile` therefore always misses for a subtask, and `TicketsPanelProvider.ts:2419-2443` returns `{ success: false }` with **no `error` field**, so `src/webview/transport.js:377-378` falls back to `'Action failed: ' + verb`. Once the files exist, this path simply succeeds. The typed-error work below is a genuine-offline courtesy, not the mechanism.

### Rejected approach — lazy import on click

An earlier draft of this plan preserved the 23811 filter and added an on-demand importer that fetched the subtask when the user clicked it. That is wrong on every axis: it issues a fresh detail API call for data the fetch already held in memory; it leaves every subtask absent from disk until someone happens to click it; it leaves the prune deleting on the next refresh; and it does not satisfy the actual requirement, which is that fetch downloads subtasks. Do not reintroduce it.

### Why this fix is small

Everything needed already exists:

| Need | Already provided by |
| :--- | :--- |
| Subtask payload with descriptions | `subtasks=true` on the list pull; `subtasksByParent` (23862-23871) |
| A writer that handles any ticket | `_writeTaskDocument` (23403) — provider-generic, no top-level assumption; `subtasks` is already an optional 5th arg defaulting to `[]` |
| `parentId:` frontmatter on the written file | `_buildLinearImportPlanContent` (7596) and `_buildClickUpImportPlanContent` (7870) — both emit `parentId: <id>` unconditionally when the task carries one |
| Subtasks kept out of the sidebar list | `TicketsPanelProvider.ts:454` (`skipSubtasks`, reading the `parentId:` frontmatter parsed at 436) and `:2320-2321` (`hiddenBySubtask`), both keyed on `parentId:` frontmatter |
| Cache stamping so the file isn't flagged `modified` | `_writeTaskDocument`'s stamp-FIRST `registerImportedTicket` (23483-23493) |
| No cross-contamination in the orphan sweep | `_removeOrphanTicketFiles` (called at 23495) keys on `${provider}_${id}_`; a subtask's id differs from its parent's, so writing a parent never sweeps its children — **no change needed** |

The change is: stop discarding them, and stop pruning them.

### What this costs per subtask file (not zero — state it honestly)

The plan's "no extra API calls" claim is true of the **ticket** pulls: no `getTaskDetails`, no `getSubtasks`, no extra list page. It is not true of everything. `_writeTaskDocument` performs three non-trivial per-call operations, and they now run once per subtask as well as once per parent:

- `_hydrateTicketAssets` (23466-23475) — downloads inline description images referenced by that ticket's body. A subtask with inline images **will** issue image downloads. These are asset fetches, not task API calls, but they are network I/O and they scale with subtask count.
- `_findTicketDocument` (23437) — a DB query plus a directory scan, to locate the previous file by id.
- `_removeOrphanTicketFiles` (23495) — a `readdir` pass over `targetDir` per written file.

For a list with heavy subtasking this is a real increase in local I/O on the import path. It is accepted, but the "costs nothing" framing must not be carried into review, because it is the sentence that makes someone skip measuring a 15-ticket list that just became 90 files.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, backend, bugfix
- **Project:** Browser Switchboard

## Complexity Audit (Routine vs Complex/Risky)

**Routine**
- Writing subtask items through the existing `_writeTaskDocument` in the existing loop.
- Adding an `error` string and a typed `reason` to the `readLocalTicketFile` failure body.
- Teaching `transport.js` not to raise a generic toast for a typed, expected miss.

**Complex / Risky**
- **The prune keep-set (highest risk).** `keepIds` is derived from the subtask-filtered `items` (23890) and the prune (24008-24044) deletes anything not in it. Subtask ids MUST be added or every subtask file is deleted on the very next full refresh — a regression invisible until one refresh later. This is the single item most likely to be missed.
- **`keepIds` has a second consumer — do not break it.** The orphan-subtask block at 23957-23958 tests `if (!parentId || keepIds.has(parentId)) { continue; }`, i.e. it uses `keepIds` to mean *"parents we already wrote in the main loop"*. Adding **subtask** ids to `keepIds` is safe because that test reads `parentId` values only — but it means `keepIds` now mixes two populations, and any future code that reads it as "the top-level set" is wrong. If clarity is preferred, add the subtask ids to `keepIds` immediately **before the prune** rather than at 23890, leaving the orphan block's view unchanged. Either is correct; picking one and commenting why is mandatory.
- **The conflict guard must run per-subtask.** The write loop's `!authoritative` mtime-vs-`last_synced_at` guard (23922-23938) is what protects unpushed local edits. A subtask written without the same guard clobbers a subtask the user was editing on the next background delta.
- **Sidebar scope must not change.** Subtask files must never appear as top-level rows. The exclusion is entirely frontmatter-driven, so it holds *provided* `parentId:` is written on every subtask file. Verify the frontmatter rather than assuming it — it is load-bearing for `skipSubtasks` (454), `hiddenBySubtask` (2320-2321), and the nominator's `/^parentId:\s*\S+/m` skip at `TaskViewerProvider.ts:23566`.
- **Delta pulls.** `date_updated_gt` filters at the record level, so a changed subtask commonly arrives with its unchanged parent absent from `items` (the orphan-group case at 23956-23998). Those subtasks must get their file written/updated too, not only the parent's checklist line — and see the ordering defect called out in Proposed Changes (d), which is what makes the naive version of this silently do nothing.
- **File count.** A 15-ticket list with heavy subtasking now writes substantially more files. This is the accepted, requested consequence. It costs no additional API calls, and the sidebar row count is unchanged.
- **`imported_docs` stores absolute paths** — a known inconsistency behind past "no local file" reports. Subtask rows must be written by the same `registerImportedTicket` call the top-level path uses; do not introduce a relative-path row.

## Edge-Case & Dependency Audit

1. **Closed/done subtasks.** The parent's checklist renders them and the drill-down lists them, so every one must be clickable. Write a file for **every** subtask of a written parent regardless of status — do NOT apply the top-level `includeClosed` filter to subtasks. Filtering them would leave exactly the original bug for closed subtasks.
2. **Prune vs closed subtasks.** `rawRemoteIds` is built pre-filter (23886) and already contains closed and subtask ids, so the deletion sweep (24068+) already spares them — and that sweep additionally proves each nomination against the ticket's own endpoint via `_confirmRemotelyDeleted` before unlinking. Only `keepIds` needs the addition.
3. **Genuinely deleted subtask.** If a subtask id is absent from `rawRemoteIds` on an authoritative fetch, it SHOULD be pruned, same rule as a top-level ticket. Do not blanket-exempt files carrying `parentId:`.
4. **Short/failed fetch.** `fetchIsAuthoritative` already gates on `rawItemCount > 0`. Do not weaken it — a short fetch must not delete subtask files (the documented destructive-prune-on-short-fetch failure mode).
5. **Nested subtasks.** ClickUp permits `parent` chains. `_isSubtask` is a flat `!!parentId` test, so a grandchild is written as its own file with `parentId` pointing at the middle node. That is correct and needs no recursion; it stays out of the sidebar for the same frontmatter reason.
6. **Cross-list subtasks.** `_mergeSubtasksSection`'s comment warns a list payload is not authoritative for the *set* of subtasks — a subtask can live in another list and be absent from this pull. That constraint is unchanged: this plan writes files for the subtasks that DO arrive and never regenerates the parent's section from a list payload. A cross-list subtask that never arrives in any pull still has no file; it remains reachable via the parent's checklist and the live-detail fallback.
7. **Directory placement.** Subtasks written in the main loop land in the same `targetDir` as their parents by construction — parent and children stay together, which is what `_findTicketFilePath`'s scan and the prune's directory-ownership model both assume. For an orphan group (parent absent from `items`), place the subtask beside the parent's existing file via `path.dirname(parentFile)`, never at a hierarchy-derived path that could scatter it.
8. **Parent's `## Subtasks` checklist stays.** It is the drill-down's navigation surface. This plan adds files; it removes nothing.
9. **Standalone host.** All work is inside `importAllTasks` / `_writeTaskDocument`, already shared by both hosts. No new command registration, no new seam.
10. **The toast.** Once files exist the miss is rare but not impossible (offline, revoked token, cross-list subtask per (6)). The typed reply must carry a real message; the user must never again see `Action failed: readLocalTicketFile`.
11. **No confirm dialogs** (repo rule).
12. **This is not a "burst API" concern — but it is not free either.** Zero additional *ticket* API calls are introduced: no `getTaskDetails`, no `getSubtasks`, no extra list page. The payload is already in hand. What does scale with subtask count is per-file work inside `_writeTaskDocument` — inline-image hydration, the `_findTicketDocument` lookup, and the `_removeOrphanTicketFiles` readdir. See "What this costs per subtask file" above; do not carry a flat "costs nothing" claim into review.

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — write the subtasks the fetch already downloaded

**a) Stop discarding them (line 23887).** Keep the closed filter for top-level tickets, drop the subtask exclusion, and carry the subtasks through to the write loop. Replace the "Progressive import" comment block at 23845-23851 — it now documents the opposite of the intended behavior. Capture `subtaskItems` **before** the `items = items.filter(...)` reassignment on 23887, or it reads the already-filtered array and is always empty.

```ts
// Every ticket the fetch returns becomes a local file, subtasks included: the
// payload already carries them (`subtasks=true` on the list pull), so this costs
// no extra API calls. Subtasks are written with `parentId:` frontmatter, which is
// what keeps them out of the sidebar's flat list (TicketsPanelProvider skipSubtasks
// / hiddenBySubtask) while still giving them a file to open, edit and push.
// Closed subtasks are written regardless of includeClosed: the parent's checklist
// renders them, so every one must be clickable.
const subtaskItems = items.filter(_isSubtask);
items = items.filter(it => !_isSubtask(it) && (includeClosed || !_isClosed(it)));
```

**b) Write them, with the same conflict guard.** Extract the write loop's per-item body (23912-23947) so subtasks reuse the guard verbatim, then run it over the subtasks of every parent that survived the filter. Subtasks pass an empty `subtasks` argument (the 5th parameter of `_writeTaskDocument`, default `[]`) — no recursion, and no `## Subtasks` section on a subtask's own file.

```ts
// Subtasks of tickets we are importing. Same conflict guard as the parent loop:
// without it a background delta silently clobbers a subtask the user is editing.
const writtenTopLevel = new Set(items.map(it => String(it?.id || '')).filter(Boolean));
for (const sub of subtaskItems) {
    if (!writtenTopLevel.has(String(sub?.parentId || ''))) { continue; } // orphan group, handled below
    if (!authoritative && sub.id) { /* identical mtime > last_synced_at + 1000 skip */ }
    const res = await this._writeTaskDocument(resolvedRoot, provider, sub, targetDir, []);
    ...
}
```

**c) Keep-set — the high-risk item.** Add subtask ids to `keepIds` so the prune spares them. `keepIds` is currently built at 23890 from the filtered `items`. Add them after the write loop (so the set reflects ids actually written) and before the prune at 24008 — see the Complexity Audit note on `keepIds`' second consumer at 23958.

```ts
// Subtask files are real files now, and the prune deletes anything not in this
// set. Sourced from the ids we actually wrote — a subtask whose parent is gone,
// or which is absent from the remote, is still correctly pruned.
for (const sub of subtaskItems) {
    const sid = String(sub?.id || '');
    if (sid && writtenTopLevel.has(String(sub?.parentId || ''))) { keepIds.add(sid); }
}
```

**d) Orphan groups (delta case) — write the file, not just the checklist line. Mind the guard ordering; this is the subtlest item in the plan.**

The existing `fetchIsAuthoritative` orphan block is at 23956-23998. The obvious implementation — append the subtask writes *after* the section merge — **silently does nothing in two common cases**, because the block `continue`s out before ever reaching them:

```ts
if (headingIdx === -1) { continue; }        // 23968 — parent has no `## Subtasks` section yet
...
if (!parentFile || !fs.existsSync(parentFile)) { continue; }   // 23961 — parent file not found
```

Both guards exist to protect the **parent's checklist**, and both are correct for that purpose. Neither has anything to do with whether the subtask deserves its own file. A parent imported before the `## Subtasks` section existed, or a parent whose file was never written, would leave its changed subtasks with no file — the original bug, surviving the fix, on exactly the delta path that is the normal way a subtask edit arrives.

**Write the subtask files first, gated only on resolving a directory to write them into**, then fall through to the existing checklist-merge logic with its guards untouched:

```ts
for (const [parentId, group] of subtasksByParent) {
    if (!parentId || keepIds.has(parentId)) { continue; }
    const parentFile = await this._findTicketDocument(resolvedRoot, provider, parentId);

    // Subtask files FIRST, and deliberately NOT behind the two guards below.
    // Those guards protect the parent's `## Subtasks` checklist — a missing
    // parent file or a parent with no section yet says nothing about whether
    // the subtask itself should land on disk. Putting these writes after them
    // reproduces the original bug on the delta path, which is the normal way a
    // subtask edit arrives (date_updated_gt filters at the record level, so the
    // unchanged parent is absent from `items`).
    const subDir = parentFile ? path.dirname(parentFile) : targetDir;
    for (const s of group) {
        const sid = String(s?.id || '');
        if (!sid) { continue; }
        if (!authoritative && /* same mtime > last_synced_at + 1000 guard, keyed `${provider}_${sid}` */) {
            skippedModified++;
            continue;
        }
        const r = await this._writeTaskDocument(resolvedRoot, provider, s, subDir, []);
        if (r.success) { keepIds.add(sid); }
    }

    // ... existing checklist merge, guards and all, unchanged from here.
    if (!parentFile || !fs.existsSync(parentFile)) { continue; }
    ...
}
```

The `targetDir` fallback keeps a subtask with an unlocatable parent in the list directory rather than dropping it. Note the consequence and accept it deliberately: such a file's parent is not present, so it is reachable only by a later full pull that writes the parent — it is not lost, just not yet navigable.

**e) `_removeOrphanTicketFiles` (23171, called per-write at 23495) — no change.** It keys on `${provider}_${id}_`, and a subtask's id is not its parent's, so writing a parent cannot sweep its children. Confirm this in review rather than editing it.

### `src/services/TicketsPanelProvider.ts` — a real message on a real miss

**There are THREE failure arms, not one** — `readLocalTicketFile` spans 2419-2443 and returns a bare `{ type, provider, id, success: false }` (no `error` key) from each of:

| Line | Condition | Classification |
| :--- | :--- | :--- |
| 2424 | `!workspaceRoot \|\| !provider \|\| !id` | A genuine caller/programming error — **not** `not-imported` |
| 2429 | `_findTicketFilePath` returned nothing | `not-imported` |
| 2436 | `_readTicketFilePayload` returned nothing (file present but unreadable/unparseable) | `not-imported` |

Patching only one arm leaves `Action failed: readLocalTicketFile` firing from the others — which is precisely the reported symptom, still reproducible, with the plan marked done. Give 2429 and 2436 the typed `reason` and a human `error`; give 2424 a plain `error` string with no quiet-listed `reason`, because a missing id genuinely warrants a visible toast.

No lazy import, no fetch — with the files now written at fetch time these paths mean something genuinely went wrong (offline, revoked token, cross-list subtask).

```ts
const res = {
    type: 'localTicketFileRead', provider, id, success: false,
    reason: 'not-imported',
    error: `No local file for ${id} yet — showing the live view. Refetch the list to download it.`
};
```

### `src/webview/transport.js` — no generic toast for a typed expected miss

At the `success === false` branch (377), skip the toast for a known reason but still dispatch the message so the panel falls back to the live view. The fall-through already exists and is deliberate — the current code returns early **only** for an untyped body, with a comment explaining that a typed failure is an addressed reply whose panel handler owns the recovery UI. Preserve that; add only the toast suppression.

```js
if (result && typeof result === 'object' && result.success === false) {
    const EXPECTED_QUIET = new Set(['not-imported']);
    if (!EXPECTED_QUIET.has(result.reason)) {
        const text = result.error || ('Action failed: ' + verb);
        ...
    }
    if (typeof result.type !== 'string') { return; }
}
```

### `src/webview/tickets.js` — do not blank the pane on the fallback

In the `localTicketFileRead` handler, when `success === false` and `reason === 'not-imported'`, keep the live-detail result as the displayed source instead of clearing. No new UI copy — this is now a rare fallback, and unreachable-edge-case status UI is not wanted.

## Resolved Assumptions

**Settled by live probe on 2026-08-13 — do not re-open, and do not commission research on it.**

The load-bearing premise of this plan — "the subtask data is already downloaded, complete, with descriptions" — was verified directly against the live ClickUp API through the running LocalApiServer proxy, issuing the exact request the extension issues:

`GET /v2/list/901615209243/task?page=0&subtasks=true&include_closed=true&include_markdown_description=true` (list "Sprint 4 (10/8 – 23/8)")

| Measurement | Result |
| :--- | :--- |
| Records returned | **44** — 22 top-level, **22 subtasks**. Half the payload is already subtasks. |
| Subtasks with non-empty `markdown_description` | **19 / 22** (the 3 empties are genuinely description-less tickets, not truncation) |
| Largest subtask body | **25,103 characters** — full content, not a stub or summary |
| Top-level with non-empty `markdown_description` | 16 / 22 |

Subtask descriptions arrive **more** consistently populated than top-level ones (86% vs 73%). There is no truncation, no separate fetch required, and no per-subtask API call needed. The plan's premise holds as written.

Two edge cases were unobservable in this sample and remain design-tolerant rather than open questions: this list contained **no closed subtasks** and **no nested (grandchild) subtasks**, and every subtask belonged to the queried list. The design already handles all three by construction — it writes a file for whatever subtask records arrive, regardless of status, depth, or home list, and never assumes the payload is authoritative for the *set* of subtasks (edge case 6). So none of these change the shape or the correctness of the fix; at worst they change how much of the population it covers on some other list, which the code path handles identically.

**ClickUp's JSON is well-formed — a briefly-suspected parse hazard was traced and dismissed.** An initial capture of this payload appeared to contain invalid JSON escapes (`1\.`, plus raw newlines inside strings). That was an artifact of the capture, not the wire format: `.agents/skills/_lib/sb_api_call.sh` ends in `echo "$RESPONSE_BODY"`, and zsh's builtin `echo` interprets backslash escapes — collapsing `\\` → `\` and turning the two-character `\n` into a real newline. Re-fetching the identical request with `curl -o` straight to disk and running a **strict** parse (no escape repair) succeeds: 44 tasks, 22 subtasks. Nothing to fix, and `ClickUpSyncService`'s `JSON.parse` fallback path is not implicated. Recorded so the false lead is not re-opened — and as a note that `sb_api_call` is lossy for capturing payloads containing escapes; use `curl -o` for that.

## Verification Plan

1. **Unit — subtasks become files.** Fixture: a list payload with 2 top-level tickets, one carrying 3 subtasks (one of them closed). Run `importAllTasks`. Assert 5 files exist, and that each of the 3 subtask files carries `parentId: <parent>` frontmatter.
2. **Unit — the closed subtask is written.** Assert the closed subtask has a file even with `includeClosed: false`, while a closed *top-level* ticket does not. This is the rule that would be wrongly "cleaned up" later.
3. **Unit — prune keep-set (the high-risk item).** With subtask files on disk and a payload containing both parents and subtasks, run the reconcile and assert every subtask file **survives**. Then re-run with one subtask absent from the payload and assert that one **is** deleted. Then re-run with `rawItemCount === 0` and assert **nothing** is deleted.
4. **Unit — sidebar scope unchanged.** After the import, `listLocalTicketFiles` returns only the 2 top-level tickets, and `scopeCoverage.hiddenBySubtask === 3`.
5. **Unit — conflict guard per subtask.** Touch a subtask file so `mtime > last_synced_at + 1000`, run a non-authoritative import, assert the file is untouched and `skippedModified` incremented. Then run with `authoritative: true` and assert it IS overwritten.
6. **Unit — delta orphan group.** Payload containing a changed subtask whose parent is absent: assert the subtask's own file is written next to the parent's file AND the parent's checklist line is upserted.
6a. **Unit — delta orphan group, parent has NO `## Subtasks` section.** Same payload, but the parent's local file contains no `## Subtasks` heading. Assert the subtask's file **is still written**, and that the parent's file is left untouched (the section is not fabricated from a partial delta group). This is the test for the guard-ordering defect in Proposed Changes (d); without it, the naive implementation passes test 6 and still ships the original bug.
6b. **Unit — delta orphan group, parent file missing entirely.** Assert the subtask's file is written into the list `targetDir` and no exception escapes.
7. **Unit — no extra API calls.** Assert the import performs no `getTaskDetails` / `getSubtasks` call beyond the existing list pulls. This is the property that distinguishes this fix from the rejected lazy-import design.
8. **Unit — typed failure body, all three arms.** Assert a non-empty `error` string on every failure return of `readLocalTicketFile` (2424, 2429, 2436) — `undefined` here is exactly what produced the generic toast. Assert `reason: 'not-imported'` on the 2429 and 2436 arms, and assert the 2424 (missing workspaceRoot/provider/id) arm does **not** carry a quiet-listed reason, so a genuine caller error still surfaces.
9. **Unit — transport quiet path.** Feed the reply handler `{ success: false, reason: 'not-imported', type: 'localTicketFileRead' }`; assert no toast is emitted and the message IS re-dispatched.
10. **Regression.** `src/test/tickets-subtask-embedding.test.js`, `src/test/tickets-sidebar-list-scoping.test.js`, `src/test/tickets-refetch-full-pull-regression.test.js`, `src/test/tickets-delta-sweep-gate-regression.test.js`, `src/test/verb-engine-tickets-headless.test.js`. Five regression tests are red at HEAD independently — stash-verify before attributing red to this change.
11. **Unit — the click path is not the mechanism.** Assert `clickupLoadTaskDetails` / `linearLoadTaskDetails` still write no files (they are read-only detail loads by design); the persistence must come from the fetch. This test exists to stop a future "fix" from being re-implemented as a lazy on-click import.
12. **Unit — `importTicketSubtasks` is neither wired nor removed.** Assert `src/webview/` still contains no sender (re-wiring reintroduces the body-leak bug) AND that the verb is still present in `TICKETS_VERBS` and `protocol-catalog.json` (it is live HTTP surface). Existing tests at `tickets-subtask-embedding.test.js:350-364` continue to pass untouched.
13. **Manual.** With the extension running: Refetch a ClickUp list.
    - `clickup_<subtaskId>_*.md` files now exist in the list directory, next to their parents, immediately after the fetch — before clicking anything.
    - The sidebar row count is unchanged; no subtask appears as a top-level row.
    - Drill into a parent and click a subtask: content appears instantly from the local file, no `Action failed` toast, no API round trip.
    - **Reload the panel, then click the same subtask with the network unavailable.** It must still render from its file. This is the check that distinguishes a real download from the current in-memory-only detail cache, which looks identical until the panel is reloaded.
    - Refetch again: every subtask file survives.
    - The browser panel is served from the installed VSIX's `dist/`, not `src/` — rebuild and reinstall before concluding a fix did not land.

## Completion Summary

Implemented in `src/services/TaskViewerProvider.ts`, `src/services/TicketsPanelProvider.ts`, `src/webview/transport.js`, and `src/webview/tickets.js` (only this subtask's regions; the in-flight loose-list and push-scope work in `tickets.js`/the tickets panel files was left untouched). (a) The "Progressive import" comment justifying the subtask discard was replaced and `subtaskItems` is now captured before the filter reassignment; the subtask exclusion was dropped from the `items` filter so subtasks reach the write path. (b) A new subtask write loop runs after the parent loop with the identical `mtime > last_synced_at + 1000` conflict guard, writing each subtask via `_writeTaskDocument(..., [])` (empty subtasks arg — no recursion, no `## Subtasks` section on a subtask's own file). (c) A `writtenSubtaskIds` set collects successfully-written subtask ids from both the in-loop and orphan-group writes and is transferred into `keepIds` immediately before the prune — deliberately after the orphan block so that block's view of `keepIds` as the top-level set is unchanged (this is also what makes nested/grandchild subtasks resolve correctly, since a subtask-parent is not yet in `keepIds` when the orphan block runs). (d) The orphan-group block now writes subtask files FIRST, gated only on resolving a directory (`path.dirname(parentFile)` with a `targetDir` fallback), before the two checklist-merge guards (`!parentFile` and `headingIdx === -1`) — fixing the delta-path case where a changed subtask's parent is absent from `items`. (e) `_removeOrphanTicketFiles` was left unchanged per the plan (it keys on `${provider}_${id}_`, and a subtask id is not its parent's). The three `readLocalTicketFile` failure arms now carry a non-empty `error` string; the two `not-imported` arms (file-not-found, file-unreadable) carry `reason: 'not-imported'`, while the missing-argument arm carries a plain error with no quiet reason so genuine caller errors still toast. `transport.js` suppresses the generic toast for `reason: 'not-imported'` while still re-dispatching the typed body, and the `tickets.js` `localTicketFileRead` handler keeps the displayed live-view source on a `not-imported` miss instead of blanking. No compilation or automated tests were run per instruction; the deletion sweep still uses the pre-filter `rawRemoteIds` so genuinely-removed subtasks are pruned and closed/subtask files are spared, and `fetchIsAuthoritative`'s `rawItemCount > 0` gate is unchanged so a short fetch deletes nothing.

### Head-agent review addendum

Point (c) above describes the keep-set as it was first written and no longer matches the code. Review found that keying subtask keeps on write success — while parents are keyed on payload presence — meant a transient `_writeTaskDocument` failure dropped a subtask from `keepIds` and the prune then unlinked its pre-existing file and deleted its DB row, escalating a retryable error into data loss with no equivalent risk for parents. The keep-set is now seeded from `subtaskItems` (the payload), which is a superset of both write loops, still includes closed subtasks, and still prunes subtasks absent from the payload. The `writtenSubtaskIds` set became write-only after that change and was removed; the orphan-group write now reports into `successCount`/`failCount` like the in-loop write, where its failures were previously swallowed.

## Review Findings

No CRITICAL or MAJOR defects found in this subtask's own code. Re-verified the three highest-risk items against source rather than the completion report: the `mtime > last_synced_at + 1000` conflict guard is duplicated verbatim in all three write loops (`TaskViewerProvider.ts:24143`, `:24194`, plus the parent loop at `:24104`); the keep-set is seeded from `subtaskItems` (the payload) immediately before the prune at `:24279`, which is the correct asymmetry fix — keying on write success would have let a transient `_writeTaskDocument` error unlink a pre-existing subtask file and delete its DB row; and `fetchIsAuthoritative` is genuinely true on a delta pull (`fetchComplete = true` at `:23961`), so the guard-ordering fix in Proposed Changes (d) actually executes on the path it was written for. The three `readLocalTicketFile` arms all carry a non-empty `error`, only the two file-miss arms carry `reason: 'not-imported'`, and `transport.js` suppresses the toast while still re-dispatching. Orphan sweep confirmed clean: `writtenSubtaskIds` was fully removed with no stragglers.

Validation (this dispatch carried no SKIP directive, so the plan's "no tests were run" note is a record, not an instruction): `tsc --noEmit` clean; `tickets-sidebar-scoping`, `tickets-delta-sweep-gate`, `tickets-refetch-full-pull`, `verb-engine-tickets` (49), `tickets-subtask-embedding`, `tickets-auto-refresh`, `tickets-cross-panel-scope` all pass, as do `parity:check`, `catalog:check`, `push-routing:check`, `verb-returns:check` and `standalone-parity:check`. Remaining risk: Verification steps 1–12 were never written as tests, so subtask-file creation, the closed-subtask rule, keep-set survival, the per-subtask guard and the three orphan-group cases (6/6a/6b) are covered only by typecheck and the pre-existing suites — that is this subtask's largest residual gap. NIT: the nominator comment at `:23738` ("Progressive import embeds subtasks in the parent file") is now stale, though the `parentId:` skip itself remains correct because subtask deletion flows through the prune's keep-set per edge case 2.
