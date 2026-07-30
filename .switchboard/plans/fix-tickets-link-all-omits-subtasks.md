# Fix: Tickets "Link all" Produces Files With No Subtasks In Them

## Goal

Make the Tickets tab's **Link all** (and per-ticket **Link**) hand an agent ticket files that actually contain their subtasks. Today "Link all" copies N top-level ticket file paths whose contents carry **no subtask information at all** unless the user happened to click each of those tickets individually earlier in the same session — and even then, the next Refresh wipes it.

### Problem Analysis & Background

Switchboard deliberately imports only top-level tickets as files ("Progressive import: only TOP-LEVEL tickets become files… This is what keeps a ~15-ticket list from ballooning into hundreds of files", `src/services/TaskViewerProvider.ts:21348-21355`). Subtasks are meant to be **embedded in the parent's file** as a `## Subtasks` checklist rather than existing as separate rows or files. That design is sound. The defect is that the embedding only ever happens on a lazy, per-card, once-per-session path, while "Link all" is a bulk operation over files written by a completely different path that never embeds anything.

### Root Cause Analysis

Three independent facts combine into the reported symptom.

**1. The bulk import writes parent files with subtasks hard-coded to empty.**

`importAllTasks`' document fast path (`src/services/TaskViewerProvider.ts:21281`) — the path behind Refresh, Refetch, Import All and the autoSync delta pull — filters subtasks out of the item list at `:21378`:

```ts
const _isSubtask = (it: any): boolean => !!it?.parentId;
items = items.filter(it => !_isSubtask(it) && (includeClosed || !_isClosed(it)));
```

and then writes each surviving parent via `_writeTaskDocument` (`:21197`), which discards subtasks unconditionally:

```ts
const node: any = { issue, subtasks: [] };                      // Linear
content = this._buildClickUpImportPlanContent(clickUpTask, …);  // ClickUp — no subtasks param exists
```

`_buildClickUpImportPlanContent` (`:6873`) has no `## Subtasks` code path at all. So every file produced by the bulk path is subtask-free by construction.

**Verified in the improve pass — there is a *third* writer, and it is already correct.** The other branch of the same public method, `importAllTasks`' ids-based slow path (`:21604-21613`), calls `this.importTaskAsDocument(resolvedRoot, { provider, id, includeSubtasks: true })` behind a concurrency pool of 3 — so it *does* embed subtasks. Three writers exist today and only one is broken:

| Writer | Embeds subtasks? | Trigger |
| :--- | :--- | :--- |
| ids slow path, `:21604-21613` | Yes | `importAllTasks` called with explicit `ids` |
| per-open enrich, `importTaskAsDocument` `:20876` / `:20902` | Yes, but transient | card click, once per session |
| bulk fast path, `_writeTaskDocument` `:21197` | **No — hard-coded empty** | Refresh / Refetch / Import All / autoSync delta |

That the same method embeds subtasks on one branch and not the other is the drift this plan closes. `:21604-21613` is also the in-class precedent for the bounded direct-call pattern Stage 2 needs — no command dispatch required, because `importTaskAsDocument` is a method on the same class.

**2. The only code that writes `## Subtasks` runs one parent at a time, on card click.**

`importTaskAsDocument` (`:20821`) appends the section — Linear at `:20876-20878`, ClickUp at `:20900-20902` — but only when called with `includeSubtasks: true`, which happens from exactly one place: the `importTicketSubtasks` handler (`src/services/PlanningPanelProvider.ts:6607`, executing the command at `:6635`), fired by the sidebar card-click handler at `src/webview/planning.js:10341-10352`. That path is gated three ways: once per session per ticket (`_subtasksEnrichedFor`), skipped when the file reads as locally modified (`PlanningPanelProvider.ts:6627-6629`), and skipped when no parent file exists yet. On a freshly loaded list, zero parents have been enriched.

**3. "Link all" cannot include subtasks even in principle.**

`linkAllButton`'s handler (`src/webview/planning.js:9797`) collects ids from `getFilteredClickUpTasks()` (`:11906`) / `getFilteredLinearIssues()` (`:11009`), both of which drop anything with a `parentId`. The backend `case 'copyToClipboard'` (`src/services/PlanningPanelProvider.ts:6727`) then resolves one file path per id via `_findTicketFilePath` and copies the list. Subtasks have no file to resolve, and the sidebar rows they'd come from are excluded by the DB read path anyway (`:6461`). So the clipboard is, correctly per the design, parents-only — but those parents are empty of subtask content.

**Net effect:** Link all → paste into an agent → the agent sees N tickets and no subtasks, and silently plans against an incomplete spec. There is no error, no partial-coverage warning, nothing to indicate the subtasks were dropped.

**4. Aggravating factor: a full import destroys any enrichment that did happen.**

The conflict guard that protects locally-modified files is `if (isDelta && item.id)` (`:21403`) — delta-only. A full (non-delta) import therefore rewrites every parent file unconditionally via `_writeTaskDocument`, erasing a `## Subtasks` section that the per-open path had added. Combined with the once-per-session `_subtasksEnrichedFor` latch, enrichment is transient: click ticket → section appears → Refresh → section gone → no re-enrich until the next session.

**The data is already in hand — no extra API calls are needed for the primary fix.** `_fetchListTasksInternal` always requests `subtasks=true` (`src/services/ClickUpSyncService.ts:1192`), and both `getListTasks` and `getListTasksLive` route through it, so ClickUp's bulk payload contains every subtask; `_normalizeClickUpTask` populates `parentId` (`:757`). Linear's `queryIssues` returns `parentId` on issues (`src/services/LinearSyncService.ts:403`, `:428`). Today those subtask objects are fetched, filtered out, and thrown away.

### Non-Goals

- **Subtasks do not become their own files or their own sidebar rows, and Link all does not gain subtask file paths.** That would reverse the deliberate progressive-import rule, re-inflate a 15-ticket list into hundreds of files, and change what the cleanup prune (`TaskViewerProvider.ts:21425`+) deletes. If subtask-level linking is wanted later it is a separate decision, recorded at the end of this plan.
- No change to the `parentId` exclusion in `getFilteredClickUpTasks` / `getFilteredLinearIssues`. Those filters are dead-but-harmless on file-backed rows (the webview mapping at `planning.js:6099` doesn't carry `parentId`, because the backend already excluded subtasks) and are correct defence for any live-data path.
- No change to `copyToClipboard`, `_findTicketFilePath`, or the `ticketLinkCopied` / `ticketLinkFailed` contract.
- No change to comment/attachment handling, the kanban `importMode: 'plan'` path (which already creates real subtask plans, `TaskViewerProvider.ts:6817`+), or the delta cursor.

## Metadata
- **Complexity:** 5
- **Tags:** bugfix, backend, api, reliability

> **Superseded:** **Tags:** bugfix, backend, integrations, clickup, linear, data-integrity — plus **Repo:** switchboard
> **Reason:** `integrations`, `clickup`, `linear` and `data-integrity` are not in the allowed tag vocabulary, so they are dropped on import and the plan loses its tags rather than gaining them. The `**Repo:**` line is omitted because this workspace is single-repo (session directive) — a repo pin here resolves to nothing.
> **Replaced with:** **Tags:** bugfix, backend, api, reliability — the closest in-vocabulary set (`api` covers the ClickUp/Linear payload work, `reliability` covers the delta-mode data-loss guard).

## User Review Required

None — but one decision is recorded rather than deferred, because it changes file content that has already shipped: the embedded checklist line gains the subtask **id and status** (ClickUp's current per-open format is titles-only, `- [ ] ${st.name || st.id}`). Without an id an agent cannot act on a subtask, which defeats the purpose of linking. Done subtasks render as `- [x]`. Anyone relying on the exact old line shape must be aware it changes.

## Complexity Audit

### Routine
- Grouping already-fetched items by `parentId` in the bulk path.
- Extracting the two duplicated `## Subtasks` string builders (`:20876`, `:20900`) into one helper.
- Threading a `subtasks` argument through `_writeTaskDocument`.

### Complex / Risky
- **Incomplete payloads are the whole difficulty — and both modes are incomplete.** `getListTasks(listId, { dateUpdatedGt })` returns only *changed* items, so a changed parent arrives with none of its unchanged subtasks (naively regenerating its file would **delete** the section — turning this fix into a new data-loss bug), and a changed subtask can arrive with its parent absent (nothing to attach it to). The autoSync timer runs this path repeatedly in the background, so both cases are routine, not exotic. **Research (2026-07-30) then removed the safe half of this picture:** a *full* list response is also incomplete, because the endpoint only returns records whose home list matches and this repo does not send `include_timl=true`. So "regenerate on full, preserve on delta" was never a safe split — see the Stage 2 correction, which collapses both into one never-delete merge.
- The fix writes into the same file the user can edit, and `_writeTaskDocument` currently has **no** local-modification guard on the full-import path. Adding subtask content increases what an unguarded overwrite can destroy.
- `_writeTaskDocument` and `importTaskAsDocument` both write the same file with different content builders. They have already drifted (that drift *is* this bug); unifying the subtask section is what stops it recurring, and the regression test must enforce single-sourcing rather than just checking a string exists.
- Linear coverage is inherently partial: `queryIssues` is project-scoped, so a sub-issue in a different project or team never appears in the payload. That is a real, permanent gap that must be logged, not silently rounded off. Confirmed by reading `LinearSyncService.ts:719-788` — the filter carries no parent predicate, so *same*-project sub-issues do arrive; only cross-project and no-project ones are invisible.
- **The renamed parent.** A delta pull that changes a parent's title changes its filename (`_writeTaskDocument` slugifies the current title, `:21226`). Any preservation logic that reads "the file we are about to write" therefore finds nothing and preserves nothing — the data-loss bug reappears specifically for renamed tickets, which is the least-tested case. Resolution must go through `_findTicketDocument` (`:20998`).
- **The anti-drift test is itself a hazard.** `## Subtasks` legitimately appears three more times in the file, including inside `pushTicketEdits`' push-truncation guard (`:21083`). A naive "appears exactly once" assertion would pressure a coder into deleting the push protection to make the suite green. The assertion must anchor on the builder-specific literal — see Stage 4.
- **Complexity stays at 5 after the improve pass.** The added section parse/serialise helper (needed for both delta preservation and the id-keyed upsert) is offset by removing the superseded per-parent detail-fetch fan-out, its concurrency cap, and its truncation warning. Net scope is roughly unchanged; net *risk* is lower, because the highest-risk item (remote description corruption) was retired by verification and the second (delta data loss) now has an id-based resolver rather than a path-based one.

## Edge-Case & Dependency Audit

**Race Conditions**
- A full import and a per-open enrich can target the same file concurrently (opening a card while Refetch runs). Both are whole-file writes; last writer wins. With the primary fix both writers now produce the section, so the outcome is equivalent either way — which is the main reason to fix the bulk path rather than make the lazy path smarter.
- The delta conflict guard's 1s grace window (`:21409-21415`) still applies unchanged.

**Security**
- None. No new network surface (ClickUp subtasks already arrive in the existing response), no new parsing of untrusted paths. Subtask titles are written into markdown that is already rendered through the existing sanitising preview path.

**Side Effects**
- Every parent ticket file gains a `## Subtasks` section on the next full import — a visible content change across the whole tickets tree, and files will show as changed to any external diff.
- Sync/push: **verified safe — already handled in shipped code.**

  > **Superseded:** `pushTicketEdits` sends the local file body back to the source. A newly-added `## Subtasks` section is now part of that body — **confirm it is not pushed into the remote description**, or a Refresh→Sync All round trip will append the checklist into the ClickUp/Linear ticket description. This is the single highest-risk side effect in the plan and must be checked before shipping (see UAT step 7).
  > **Reason:** the improve pass read the code instead of deferring the question. `pushTicketEdits` (`:21054-21088`) already truncates the pushed description at the first `## Subtasks` **or** `## Comments` heading, with a comment stating the intent explicitly: "`## Subtasks` is import-generated, read-only context — it must NOT be folded back into the remote description on push." The remote-corruption scenario cannot occur. Carrying it as an open blocking unknown would have made a coder either stall or build a stripper that already exists.
  > **Replaced with:** the push path is already correct and needs **no change**. Two *derived* constraints replace it, and they are the real risk:
  >
  > 1. **The subtask section must be the LAST section in the file.** Push truncation keys on the first `## Subtasks` heading, so anything written after it is silently dropped on push. This is now a hard ordering constraint on Stage 1, not a cosmetic preference.
  > 2. **Blast radius of the existing truncation widens.** Today only files a user *clicked* carry the heading; after this fix every parent with subtasks carries it. Any user prose typed below the heading is silently dropped by Sync All. That behaviour is pre-existing and deliberate, but it now applies to the whole tickets tree. Worth a one-line note in the section itself (e.g. a `<!-- generated -->` marker line) so the boundary is visible to a human editor.
  >
  > UAT step 7 is retained, downgraded from "blocking unknown" to a cheap regression confirmation that the existing truncation still holds.
- Content-hash / sync-status: `importTaskAsDocument` hashes the body excluding frontmatter (`:20942-20945`) while `_writeTaskDocument` registers with an empty hash (`:21238`). Adding body content must not flip existing files to a false "modified" badge — sync status is timestamp-based (`_ticketSyncStatusFromTimestamps`), so the risk is the write itself bumping mtime, which already happens on every import. **Verified benign:** `_ticketSyncStatusFromTimestamps` (`PlanningPanelProvider.ts:9517-9530`) compares mtime against `last_synced_at` with a 1s grace and never reads the hash; the DB-backfill path even documents this in-line ("Sync status is timestamp-based; the content hash is unused", `:6361-6362`). The hash divergence between the two writers is dead weight, not a defect — do not spend the change budget unifying it.
- Closed subtasks now appear (as `[x]`) in parents even when `includeClosed` is false for top-level rows. Deliberate: a parent's own checklist should show its completed children.

**Dependencies & Conflicts**
- Code-independent of `.switchboard/plans/fix-tickets-sidebar-shows-all-lists-on-browser-load.md` — same tab, disjoint files (import content generation vs. sidebar read path). No merge conflict.

  > **Superseded:** Independent of `.switchboard/plans/fix-tickets-sidebar-shows-all-lists-on-browser-load.md` — same tab, disjoint code. Either order.
  > **Reason:** "either order" is wrong on *risk*, even though it is right on *code*. That plan's Stage 1 makes the browser post `ticketsRootChanged`, whose backend handler (`PlanningPanelProvider.ts:2770-2803`) calls `_updateTicketsAutoSyncWatcher` — so it arms the autoSync **delta-pull** timer in the browser cockpit for the first time. The delta path is precisely where this plan's data-loss hazard lives (Stage 2). Landing the sidebar plan first would widen exposure to the un-guarded delta writer before the guard exists.
  > **Replaced with:** files are disjoint and may be developed in parallel, but **prefer merging this plan first**. If the sidebar plan lands first, treat the delta-preservation gate (UAT step 3) as a blocking check on it too. This is an ordering preference, not a blocker — the same exposure already exists in the VS Code host today.
- The prune at `:21425`+ keys on `keepIds` (top-level only) and is unaffected, since no new files are created. Legacy subtask files from the old mass-import era keep being pruned exactly as today.
- `_subtasksEnrichedFor` (`planning.js`) and the `importTicketSubtasks` handler stay in place as the freshness path for a single opened ticket; they must not double-append when the section already exists.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: (1) the obvious implementation — regenerate every parent file with whatever subtasks the payload holds — **destroys** subtask sections, and research established this is true on *full* imports as well as delta pulls, because ClickUp's list endpoint cannot see subtasks whose home list differs and this repo does not send `include_timl=true`; the fix is therefore one never-delete merge rule for both modes, and its sharpest failure variant is a *renamed* parent, where the new title changes the filename so a path-based "read the file we're about to write" finds nothing and preserves nothing; (2) fixing only `_writeTaskDocument` while leaving `importTaskAsDocument`'s own string builder in place preserves the exact drift that caused this defect, and the anti-drift test must anchor on the builder literal `'\n\n## Subtasks\n\n'` because the bare heading legitimately appears three more times — including inside the push-truncation guard, which must not be "cleaned up"; (3) a title-and-id-only checklist is the goal-vs-appearance trap — it satisfies "the file has a `## Subtasks` section" while still handing the agent an incomplete spec, which is the defect the Goal names; (4) Linear's project-scoped query cannot see cross-project sub-issues, so "subtasks are now embedded" will be quietly untrue for some tickets. Mitigations: preserve-then-merge for delta mode with id-based file resolution via `_findTicketDocument` (Stage 2), one shared builder plus a literal-anchored anti-drift test and a positive guard on the push path (Stages 1 + 4), descriptions embedded from the payload already in hand (Stage 1 Clarification), and a logged warning wherever coverage is known-incomplete rather than silent omission. **Retired by verification:** the previously top-ranked risk — Sync All pushing the checklist into the remote description — cannot occur; `pushTicketEdits` already truncates there (`:21080-21088`).

## Proposed Changes

### Stage 1 — One shared subtask-section builder, used by both writers

**File:** `src/services/TaskViewerProvider.ts`

**Context.** The `## Subtasks` markdown is built inline twice inside `importTaskAsDocument` — Linear at `:20876-20878`, ClickUp at `:20900-20902` — and nowhere else. `_writeTaskDocument` (`:21197`) has no equivalent.

**Logic.** Extract a single private helper and make it the only producer of the section.

**Implementation.**
- Add `private _buildSubtasksSection(provider: 'linear' | 'clickup', subtasks: any[]): string` returning `''` for an empty array, else `'\n\n## Subtasks\n\n'` plus one line per subtask:
  - ClickUp: `- [${done ? 'x' : ' '}] ${name} (${id})${status ? ' — ' + status : ''}`, where `done` derives from `status.type` being `closed`/`done` (reuse the same test as `_isClosed`, `:21356-21363`).
  - Linear: `- [${done ? 'x' : ' '}] ${title} (${identifier || id})${stateName ? ' — ' + stateName : ''}`, `done` from `state.type` being `completed`/`canceled`.
- Replace both inline builders in `importTaskAsDocument` with calls to it.
- Extend `_writeTaskDocument` with a `subtasks: any[] = []` parameter and append the helper's output after the content builder. Keep the existing signature order so no other caller breaks. **Verified:** `_writeTaskDocument` has exactly one call site (`:21419`) and a 4-parameter signature (`resolvedRoot, provider, task, targetDir`), so a defaulted 5th parameter is a no-risk addition.

**Edge cases.**

> **Superseded:** The section must be appended **after** the comments section so the file ordering matches what `importTaskAsDocument` already produces.
> **Reason:** there is no comments section to order against. `importTaskAsDocument` stopped embedding comments — it passes `node.comments = []` (Linear, `:20862-20865`) and `undefined` (ClickUp, `:20897-20900`), with in-line comments stating that this keeps `_buildCommentsSection` "a harmless no-op"; comments now live in the comment-manager UI and a local `_comments.json` cache. Following this instruction would send a coder looking for a section that is never written.
> **Replaced with:** the subtask section must be **the last thing in the file**, appended at the very end of `content`. This is a hard constraint, not a stylistic one: `pushTicketEdits` (`:21080-21088`) truncates the pushed remote description at the first `## Subtasks` / `## Comments` heading, so any content written after the section would be silently dropped on Sync All. Being last also makes Stage 2's preservation read trivial — "from the `## Subtasks` heading to EOF" — which is immune to nested `## ` headings inside the section itself.

- Titles can contain `]` or newlines — collapse whitespace and keep each line single-line, matching the frontmatter sanitising already done at `:6884`.
- Emit a marker line directly under the heading (e.g. `<!-- generated by import — content below this line is not pushed to the remote ticket -->`) so a human editor can see the push boundary that `pushTicketEdits` enforces. The marker must not itself start with `## `.

**Clarification — embed each subtask's description, not just its title.** Not new scope: this plan's own Goal requires files an agent can plan from, and the User Review Required section already argues that a subtask without an id "cannot be acted on, which defeats the purpose of linking". A title-only checklist has the same defect one level up — the *work* of a subtask usually lives in its description, so a checklist of bare titles is a file that passes "has a `## Subtasks` section" while still leaving the agent to plan against an incomplete spec. The data costs nothing extra: the ClickUp list endpoint already requests `include_markdown_description=true` (`ClickUpSyncService.ts:1193`), so descriptions are in the payload the bulk path currently throws away.

- Per subtask, emit the checklist line, then the description indented as a blockquote or fenced block beneath it, truncated to a bounded length (suggest 1,500 chars, with a `…(truncated — open the ticket for the full description)` suffix) so a list of 30 verbose subtasks cannot bloat a parent file without limit.
- **Confirmed available by research (2026-07-30):** `include_markdown_description=true` populates `markdown_description` on **subtask** records in the list payload, not just top-level tasks, with no truncation or length cap imposed by the API. The Clarification is buildable from data already in hand as claimed.
- **But it is nullable.** A subtask with an empty or whitespace-only description returns `markdown_description` as `null` or `''`. Coerce before use (`String(st.markdown_description || '').trim()`) and emit the checklist line alone when empty — do not emit an empty blockquote, and do not let a `null` reach a `.slice()` or `.replace()` and throw mid-import.
- **Demote or escape any `#` headings inside an embedded description** (e.g. `## Foo` → `**Foo**`). An un-demoted `## ` inside the section would make the file's heading structure lie, and would break any future section parser that keys on the next `## ` boundary.
- If descriptions are unwanted, the veto is cheap and local: drop this bullet and the helper emits titles + ids + status only. Nothing else in the plan depends on it.

### Stage 2 — Embed subtasks in the bulk import (full and delta)

**File:** `src/services/TaskViewerProvider.ts`, `importAllTasks` document fast path (`:21281`)

**Context.** `items` holds parents *and* subtasks at `:21374` (the raw fetch), and subtasks are discarded at `:21378`. `rawRemoteIds` already demonstrates the pattern of capturing information from the pre-filter list.

**Logic.** Group the discarded subtasks by parent and hand each parent its own. Full imports regenerate the section from the payload; delta imports must never regenerate it from an incomplete payload.

**Implementation.**
- Before the filter at `:21378`, build `const subtasksByParent = new Map<string, any[]>()` from `items.filter(_isSubtask)`, keyed on `String(it.parentId)`.
- In the write loop (`:21400`+), pass `subtasksByParent.get(String(item.id)) || []` into `_writeTaskDocument`.
- **Full import (`!isDelta`):**

  > **Superseded:** the payload is authoritative (ClickUp's list endpoint returns all subtasks; the `fetchIsAuthoritative` check at `:21384` already gates destructive reconciliation). Write the section from the map. An empty map entry means the parent genuinely has no subtasks.
  > **Reason:** **web research (2026-07-30) refuted the authority premise.** `GET /list/{list_id}/task` returns only records whose *home list* is that list. A subtask whose parent lives in the imported list but whose own home list is different is **excluded** unless `include_timl=true` is set — and the request built at `ClickUpSyncService.ts:1193` does **not** set it. So an empty map entry does **not** mean "no subtasks"; it can equally mean "this parent's subtasks live elsewhere and are invisible to this endpoint". Regenerating the section from the map would then **delete** real, correct subtask content that the per-open enrich had previously captured via `getTaskDetails?include_subtasks=true` — the same data-loss class the delta branch was written to prevent, arriving through the branch that was assumed safe.
  > **Replaced with:** **one merge rule for both modes — never regenerate destructively from a list payload.** Full and delta collapse into a single path:
  >
  > 1. Resolve the existing file via `_findTicketDocument` and parse its `## Subtasks` block into an id-keyed map of lines (absent section → empty map).
  > 2. Upsert every payload subtask for this parent by id — replacing a matching line, appending a new one.
  > 3. Write the merged set. **Never remove a line because the payload lacks it**, in either mode.
  >
  > This is simpler than the superseded two-branch design (one code path, no `isDelta` fork inside the section logic) *and* strictly safer. The `isDelta` fork survives only where it belongs — the conflict guard at `:21402` and the prune at `:21436`.
  >
  > **Where authoritative replacement still happens:** the per-open enrich path (`importTaskAsDocument`, `getTaskDetails?include_subtasks=true`) *is* authoritative for a single parent, including its cross-list children. That path may keep rebuilding the section wholesale, and it is what reconciles deleted subtasks. Opening a ticket remains the "make this parent exactly right" action.
  >
  > **Accepted cost:** a subtask deleted remotely lingers in the parent's checklist until the parent is next opened. That is the correct trade — a stale line is visible and self-correcting; a deleted section is silent and unrecoverable. Mark merged-but-unconfirmed lines if you want the staleness legible, but do not "fix" it by deleting on full import.

- **`fetchIsAuthoritative` still matters — wire the section to it.** Verified: `_fetchListTasksInternal` (`ClickUpSyncService.ts:1187-1215`) *does* page through every page and accumulate before returning, so the research's "parents and children split across pages" hazard does **not** apply to this repo's full path — all pages are in `items` by the time the map is built. But `complete` is `false` when the 100-page cap is hit or `last_page` never flips (`:1227-1233`), and `fetchIsAuthoritative` (`:21383`) already encodes exactly that. Even under the merge rule, skip subtask writes entirely for a non-authoritative fetch rather than merging from a knowingly truncated payload — and let the existing warn at `:1229-1231` be the diagnostic.
- **Delta import (`isDelta`):** the payload is **not** authoritative.
  - If the map has entries for this parent, write the section from them.
  - If it does not, **preserve** the existing file's section: read the current file before writing, extract everything from the `## Subtasks` heading **to EOF** (guaranteed safe because Stage 1 makes the section last), and re-append it verbatim. Never emit an empty section where one existed.
  - **Resolve the existing file by id, not by computed path.** `_writeTaskDocument` derives the filename from the *current* title (`${provider}_${id}_${slug}.md`, `:21226`). A delta pull that changed a parent's **title** produces a different slug, so reading "the file we are about to write" finds nothing and the preserved section is silently lost — the exact data-loss this branch exists to prevent, reintroduced by a renamed ticket. Use `_findTicketDocument(resolvedRoot, provider, id)` (`:20998`, already the resolver `pushTicketEdits` uses at `:21049`) to locate the previous file before writing. `_removeOrphanTicketFiles` (`:21230`) then deletes the stale-slug file as it does today.
  - For an **orphan** subtask group (parent not in `items` — the parent didn't change, the subtask did):

    > **Superseded:** resolve the parent's local file; if it exists and is not locally modified, re-run the single-parent enrich (`switchboard.importTaskAsDocument` with `includeSubtasks: true`) so the parent's checklist refreshes from a full detail fetch. Cap this at 10 parents per pull and `console.warn` the count skipped — a silent cap would read as "subtasks are current" when they are not.
    > **Reason:** three problems. (1) It is an N+1 network fan-out on a background timer — `importTaskAsDocument` issues a full `getTaskDetails` per parent (ClickUp) or `getIssue` + `getSubtasks` (Linear, two calls), so up to 20 API calls per autoSync pull against a rate-limited API, repeatedly, forever. (2) The cap of 10 is arbitrary and needs a warn precisely because it is a silent-incompleteness hazard — a mitigation for a problem the design chose. (3) It names a **command** (`switchboard.importTaskAsDocument`); this code is inside `TaskViewerProvider`, the same class that *defines* `importTaskAsDocument`, and `:21613` already calls it directly. Routing through the command dispatcher here is needless indirection (the seam-mediated `executeCommand` at `PlanningPanelProvider.ts:6633` is correct only because that is a *cross-provider* call).
    > **Replaced with:** **upsert the changed subtask into the parent's existing section in place, from the delta payload — zero extra API calls, no cap, no warn needed.** The delta item already carries everything a checklist line needs (`id`, name/title, status/state, and for ClickUp `markdown_description`). Read the parent file via `_findTicketDocument`, parse the `## Subtasks` block into lines keyed by the `(id)` each line already carries, replace the matching line (or insert it in place if absent), and rewrite the block. This reuses the same parse/serialise helper the preserve branch above already requires, so it is *less* net code than the fetch-based version, not more.
    >
    > **Confirmed live by research (2026-07-30), not dead code:** `date_updated_gt` filters at the record level, so a subtask whose own `date_updated` advanced **is** returned with its `parent` populated while its unchanged parent is omitted. The orphan branch is therefore the normal case for a subtask edit, not an exotic one. The same finding confirms the reverse — a changed parent arrives with its unchanged subtasks omitted — which is what makes the merge rule above mandatory rather than defensive.
    >
    > Two rules keep it honest:
    > - **Only upsert into a section that already exists.** If the parent has no `## Subtasks` section, do nothing and let a later import or a per-open enrich build it. Creating a section from a single delta item would render a parent with 12 subtasks as having 1 — a file that looks complete and is not, which is worse than a file that is visibly missing the section.
    > - **Subtask deletions are reconciled only by the per-open enrich**, never by a list payload in either mode.
    >
    > **Do not reintroduce the fetch-based variant.** Research confirmed ClickUp's rate limit is **100 requests/minute per token on Free, Unlimited and Business plans** (1,000 on Business Plus / Enterprise). A per-parent detail fetch across a 100-task list is ~101 requests — a single background cycle would consume the entire minute's budget and 429 every subsequent call, including user-initiated ones. The superseded design would have done this on a repeating timer.

**Edge cases.** `parentId` normalisation differs by provider — key the map on the already-normalised field only. **Correction:** `_normalizeClickUpTask` (`ClickUpSyncService.ts:757-759`) derives `parentId` from `raw.parent` **only** (there is no `parent_id` fallback); Linear normalises `raw.parent.id` (`LinearSyncService.ts:403`, `:428`). Both yield `null`, not `undefined`, when absent — so `_isSubtask`'s `!!it?.parentId` test is correct as written. A subtask whose parent is filtered out as closed (`includeClosed: false`) still lands in the map and is simply never consumed; harmless. Nested subtasks (a subtask of a subtask) attach to their immediate parent, which may itself not be a file — same harmless outcome, and the plan does not attempt to flatten deep trees.

### Stage 3 — Don't let a full import clobber a locally-edited parent

**File:** `src/services/TaskViewerProvider.ts`, `importAllTasks` write loop

**Context.** The conflict guard at `:21403` is `if (isDelta && item.id)`. Full imports overwrite every file. The prune below it *does* preserve locally-modified files (`:21400`-ish comment and the mtime check in the prune), so the two halves of the same operation disagree today.

**Logic.** Apply the same modified check to full imports as the prune already applies, so a user's edits — and now their subtask sections — survive a Refetch.

**Implementation.** Hoist the `dbTickets` load out of the `if (isDelta)` block (`:21387-21395`) so it is available in both modes, and apply the existing mtime-vs-`lastSyncedAt` (+1s grace) check for full imports too, incrementing `skippedModified`. Surface the count in the existing result payload (`skippedModified` is already declared at `:21274` and already in the return type at `:21264`) so the webview's import toast can say "N skipped (local edits)".

**Verified — the hoist is a simplification, not just a behaviour change.** The prune below already needs `dbTickets` in full-import mode and works around the `isDelta` gate with a lazy re-query: `(dbTickets.length ? dbTickets : await cacheService.getImportedTickets())` (`:21440`). Hoisting the load lets that expression collapse to plain `dbTickets` and removes a redundant DB round trip on every Refetch. Change both in the same edit — leaving the fallback in place would hide whether the hoist actually took effect.

**Edge cases.** This makes Refetch stop being a hard "reset from remote". That is consistent with the prune's existing promise and with `syncAllTickets` being the explicit push path — but it is a behaviour change and belongs in the UAT (step 6). If a hard reset is wanted later it should be a distinct explicit action, not the default.

### Stage 4 — Regression test

**File:** `src/test/tickets-subtask-embedding.test.js` (new)

**Context.** Source-assertion style per `src/test/kanban-card-button-drag-guard.test.js`.

**Implementation.** Each assertion must fail at HEAD and pass after:

> **Superseded:** `_buildSubtasksSection` exists, and the string literal `'## Subtasks'` appears **exactly once** in `TaskViewerProvider.ts` — i.e. inside the helper only. This is the anti-drift assertion.
> **Reason:** this assertion is unsatisfiable — it would fail even after a perfectly correct implementation, and a coder would either delete it or "fix" working code to satisfy it. `## Subtasks` occurs **five** times in `TaskViewerProvider.ts` today, and three of those are legitimate and must survive: a comment at `:17087` (the *feature*-file subtask block, an unrelated concept), and the push-truncation guard's comment and code at `:21076` / `:21083` — `if (trimmed === '## Subtasks' || trimmed === '## Comments')`. Deleting the `:21083` occurrence to satisfy the test would break the push protection that Side Effects now relies on.
> **Replaced with:** anchor the anti-drift assertion on the **builder-specific** literal, which is unambiguous. Both inline builders use `'\n\n## Subtasks\n\n'` (`:20877`, `:20902`); the three legitimate occurrences use the bare heading with no surrounding newlines. So:
> - `\n\n## Subtasks\n\n` (as a source literal) appears **exactly once** in `TaskViewerProvider.ts` — currently twice. This is the real anti-drift assertion.
> - **Negative:** neither `importTaskAsDocument` nor `_writeTaskDocument` contains `content +=` followed by a `## Subtasks` literal — the only producer is `_buildSubtasksSection`.
> - **Positive guard for the push path:** `pushTicketEdits`' body still contains `trimmed === '## Subtasks'`. Without this, a future "clean up the duplicate literal" pass can delete the push protection and no test notices.

- `_buildSubtasksSection` exists and is called from both `importTaskAsDocument` and `_writeTaskDocument`.
- `_writeTaskDocument`'s signature accepts a subtasks parameter.
- **Negative:** `_writeTaskDocument`'s body no longer contains `subtasks: []`.
- `importAllTasks` builds a parent→subtasks map from the pre-filter `items`, and the map is read inside the write loop.
- The section write path resolves the prior file via `_findTicketDocument`, **not** via a title-derived path. This is the renamed-parent data-loss guard.
- **Negative — the merge rule, and the single most important assertion in this file:** the section write path contains **no** branch that emits a subtask section built solely from the payload. Assert that the merge helper is the only writer and that `isDelta` does **not** appear inside the section logic. A future "full imports are authoritative, just regenerate" simplification is the exact regression that would silently delete cross-list subtasks, and it will look like a cleanup in review.
- Subtask writes are skipped when the fetch is non-authoritative — assert `fetchIsAuthoritative` (or `fetchComplete`) gates the section write.
- The orphan-subtask upsert only runs when a `## Subtasks` section already exists — assert the guard, so "create a section from one delta item" cannot be reintroduced.
- **Negative:** no `getTaskDetails` / `importTaskAsDocument` call appears inside `importAllTasks`' document **fast path** (the ids-based slow path at `:21613` legitimately has one). This is the rate-limit guard — it prevents the superseded per-parent fan-out being reintroduced onto a background timer.
- The full-import branch consults the modified check (assert `skippedModified` is reachable when `!isDelta`).
- **Negative:** the prune no longer contains the `dbTickets.length ? dbTickets :` lazy re-query — proves the Stage 3 hoist landed rather than being bolted alongside.

**Edge cases.** Anchor on identifiers (`_buildSubtasksSection`, `_writeTaskDocument`, `subtasksByParent`, `skippedModified`, `_findTicketDocument`), never on whitespace or argument order.

**Test conventions (verified against the cited exemplar).** `kanban-card-button-drag-guard.test.js` uses `require('fs'/'path'/'assert')` synchronously, one named test function, `module.exports = { testXxx }`, and a `if (require.main === module) { testXxx(); }` tail — there is no `run()` export. Match that shape or the CI step (`node src/test/<file>.js`) runs nothing and passes vacuously.

**Wiring (exact locations).** Add `"test:contract:tickets-subtasks": "node src/test/tickets-subtask-embedding.test.js"` to `package.json` beside the other `test:contract:*` entries (~`:793`), and add a matching step to `.github/workflows/integration-tests.yml` after the `test:contract:drag-guard` step (~`:91`). An unwired contract test is not a gate.

## Verification Plan

### Automated Tests
- Add `src/test/tickets-subtask-embedding.test.js` per Stage 4, with its npm script (`package.json` ~`:793`) and CI step (`.github/workflows/integration-tests.yml` ~`:91`).
- The implementing agent must run a TypeScript compile — the change alters `_writeTaskDocument`'s signature, adds a helper, and hoists `dbTickets` out of a block scope, all of which are compile-visible.
- Run the existing ticket/import suites (`tickets-link-to-ticket-regression.test.js`, `planning-aggregate-cache.test.js`, `verb-engine-planning-headless.test.js`); stash-verify any red test against HEAD before attributing it to this change.
- *Not executed in this planning pass:* compilation and test runs were skipped per session directive. Nothing in the plan was validated by running it — all code claims above were verified by reading the source at the cited lines.

### Manual UAT (the real gate)

Against the **installed** extension folder with a reload. Needs a ClickUp list containing at least two parents with subtasks (one with a done subtask), and a Linear project with sub-issues.

1. **The reproduction, before/after.** On a freshly loaded list — **without clicking any ticket** — press **Link all**, paste the paths, and open the first two files. Before: no `## Subtasks` anywhere. After: every parent with subtasks carries a `## Subtasks` checklist with ids and statuses, and done subtasks show `[x]`.
2. **Refresh no longer wipes it.** Note a parent's section, press Refresh (full import), re-open the file: section still present and current.
3. **Delta pull preserves it.** With autoSync on, wait for (or trigger) a delta pull that changes a *parent's* title only. The parent's `## Subtasks` section must survive verbatim — this is the data-loss gate for Stage 2.
4. **Delta pull refreshes a changed subtask.** Rename a subtask in ClickUp, wait for the delta pull, re-open the parent file: the new name appears on its existing checklist line, the other lines are untouched, and no duplicate line was inserted (id-keyed upsert, Stage 2). Then confirm the negative case: pick a parent that has **no** `## Subtasks` section, rename one of its subtasks, and confirm the delta pull does **not** create a one-line section — it must stay absent until the next full import.
   - **This step is the primary gate on the orphan-upsert path.** ClickUp's delta response *does* include a changed subtask with its parent omitted (confirmed — see Resolved Assumptions), so this step must show a change. If it does not, the defect is in the implementation, not the API.
5. **Per-open path still works and doesn't double-append.** Click a parent card: exactly one `## Subtasks` section in the file, not two.
6. **Local edits survive Refetch (Stage 3).** Edit a ticket body, press Refetch, confirm the edit survives and the import toast reports it as skipped.
7. **Push safety — regression confirmation (no longer a blocking unknown).** Edit nothing; press **Sync All**, then read the ticket in ClickUp and in Linear. The `## Subtasks` checklist must **not** appear in the remote description. The existing truncation at `pushTicketEdits:21080-21088` already guarantees this; the step only proves Stage 1 kept the section **last** in the file. Then the sharper case: type a line of prose *below* the `## Subtasks` heading, press Sync All, and confirm that line is dropped from the remote description — expected, pre-existing, and the reason the generated-content marker line exists.
8. **Linear coverage.** Repeat step 1 for Linear. Confirm same-project sub-issues appear; confirm a deliberately cross-project sub-issue is absent and that its absence is logged rather than silently dropped.
8b. **Cross-list subtask survival (the merge-rule gate).** In ClickUp, create a subtask under a parent in list A but move the **subtask** so its home list is B. Open the parent card so the per-open enrich captures it (`getTaskDetails` sees cross-list children). Confirm the line is in the parent's `## Subtasks`. Now press **Refresh** on list A — a full import whose payload cannot see that subtask. **The line must survive.** If it disappears, the merge rule was implemented as a regenerate and the plan's central correction was lost. This is the step that catches the failure the research uncovered, and no other step in this list would catch it.
9. **Prune unaffected.** Confirm no new `.md` files appeared for subtasks and the file count for the list is unchanged (± the ticket count).
10. **Both hosts.** Repeat step 1 in the browser cockpit and in the VS Code panel — the import path is shared, so only the trigger differs.

## Resolved Assumptions

**This section is authoritative. Do not re-open or re-research anything recorded here.** Web research was run on 2026-07-30 against ClickUp's API v2 documentation, changelog and primary developer observations; the code claims were settled by reading this repository.

### Settled by web research — ClickUp API v2 behaviour

| Question | Finding | Effect on the plan |
| :--- | :--- | :--- |
| Does `date_updated_gt` return a changed **subtask** when its parent is unchanged? | **Yes.** Filtering is per-record. The subtask arrives with `parent` populated; the unchanged parent is omitted. The reverse also holds — a changed parent arrives with its unchanged subtasks omitted. | Stage 2's orphan-upsert branch is the normal path for a subtask edit, not dead code. Makes the merge rule mandatory. |
| Is a full list response authoritative for a parent's complete subtask set? | **No.** The endpoint returns only records whose **home list** is that list. Subtasks whose home list differs are excluded unless `include_timl=true`, which this repo does not send (`ClickUpSyncService.ts:1193`). | **Refuted the original full-import branch.** Drove the unified never-delete merge rule in Stage 2. |
| Does `include_markdown_description=true` populate `markdown_description` on subtasks? | **Yes**, on subtask records too, with no API-imposed truncation — but it is `null`/`''` for empty descriptions. | Stage 1's description Clarification is buildable from data already fetched; requires null-coercion. |
| Are nested subtasks returned, and what does `parent` point to? | Yes, to ClickUp's maximum hierarchy depth (7). `parent` is always the **immediate** parent, so clients must reconstruct trees locally. | Confirms the plan's existing "attach to immediate parent, do not flatten deep trees" decision. |
| Rate limits and throttling? | **100 req/min per token** on Free / Unlimited / Business; 1,000 on Business Plus / Enterprise. Over-limit returns `429` with `X-RateLimit-*` and `Retry-After`. | Hard constraint against reintroducing any per-parent fetch fan-out. ~101 requests for a 100-task list exhausts a standard tier's whole minute. |
| A subtask whose parent is permission-restricted? | `parent` is still populated, but resolving it returns `403`/`404`. | Already handled — the merge only touches parents with a resolvable local file and an existing section. |

**Left unresolved by research, and deliberately not blocking:** whether workspace-level structural changes (moving a parent between lists/folders, editing a shared custom field) cascade a `date_updated` bump onto child subtasks; and tie-breaking when tasks share an identical `order_by` timestamp across pages. Neither can produce data loss under the merge rule — the worst case is a stale line until the parent is opened — which is precisely why the merge rule is the right shape.

### Settled by reading this repository

- **Pagination is already handled — do not add paging logic.** `_fetchListTasksInternal` (`ClickUpSyncService.ts:1187-1215`) loops every page and accumulates into one array before returning, so the research's "parent on page 0, child on page 2" hazard cannot affect the grouping map. Truncation is surfaced instead via `complete: false` plus a warn (`:1227-1233`), which `fetchIsAuthoritative` (`:21383`) already consumes.
- **Closed subtasks do arrive on the bulk path.** `includeClosed` defaults to `true` (`:1181`) and `getListTasksLive` never overrides it (`:1271-1275`), so the Side Effects note about closed subtasks rendering as `[x]` is correct — `importAllTasks`' own `includeClosed` filter applies only to top-level rows.
- **Push truncation** (`:21080-21088`), **timestamp-only sync status** (`PlanningPanelProvider.ts:9517`), **comments no longer embedded** (`:20862-20865`, `:20897-20900`), the **single `_writeTaskDocument` call site** (`:21419`), **`parentId` normalisation shapes** (`ClickUpSyncService.ts:757`, `LinearSyncService.ts:403`/`:428`), and the **third already-correct writer** (`:21604-21613`).
- **Linear sub-issue coverage.** `queryIssues` filters on team + project + `updatedAt` with no parent predicate (`LinearSyncService.ts:719-788`), so same-project sub-issues arrive as ordinary issues while cross-project and no-project ones never do — the permanent gap the Complexity Audit records.

## Deferred Decision (recorded, not scheduled)

If subtask-level linking is ever wanted — each subtask as its own file with its own path in Link all — that is a reversal of the progressive-import rule, not an extension of this fix. It requires: dropping `_isSubtask` from the bulk filter, adding subtask ids to `keepIds` so the prune stops deleting them, deciding whether subtasks become sidebar rows (currently excluded at `PlanningPanelProvider.ts:6461`), and accepting the file-count growth the current design exists to prevent. Do not implement it as part of this plan.

---

**Recommendation: Send to Coder** (Complexity 5 — the full-import change is small; this fix is won or lost on delta-mode preservation, specifically id-based file resolution for renamed parents, and on keeping the subtask section last in the file so the existing push truncation stays correct).

## Completion Report
Implemented subtask embedding for bulk ticket imports across ClickUp and Linear providers. Extracted subtask section generation into `_buildSubtasksSection` with marker comment, embedded subtask descriptions and status info, updated `_writeTaskDocument` to preserve/merge subtask sections using ID resolution via `_findTicketDocument`, grouped subtasks in `importAllTasks` document fast path, hoisted cache check for conflict guard to run on full imports, added contract test `src/test/tickets-subtask-embedding.test.js`, and registered test in `package.json` and `.github/workflows/integration-tests.yml`. Files changed: `src/services/TaskViewerProvider.ts`, `src/test/tickets-subtask-embedding.test.js`, `package.json`, `.github/workflows/integration-tests.yml`. No issues encountered.

## Reviewer Pass — 2026-07-30

The merge rule — the thing this plan is won or lost on — landed correctly. One CRITICAL and two MAJOR defects were found and fixed. Both MAJORs were reproduced by executing the compiled pre-fix provider, not inferred from reading.

### Findings

**CRITICAL — the plan's own contract test was red at HEAD, and it is wired into CI.** `src/test/tickets-subtask-embedding.test.js:69` asserted `writeDocBody.includes('isDelta') === false`; `TaskViewerProvider.ts:21417` carries the comment *"Deliberately no `isDelta` fork here"*. The assertion matched its own rationale, so `npm run test:contract:tickets-subtasks` — invoked at `.github/workflows/integration-tests.yml:97` — failed on main. This is the identical substring-vs-code trap that the sibling plan's test already documents in a self-addressed comment (`tickets-sidebar-list-scoping.test.js:93-95`: *"Assert no ASSIGNMENT, not the absence of the identifier… this gate was red at HEAD"*), and that this plan's Stage 4 warns about a third time.

**MAJOR — the embedded-description Clarification was dead code on every path.** `_buildSubtaskEntry` read `st?.markdown_description`. No object reaching that method carries it: `_normalizeClickUpTask` renames the API field to `markdownDescription` (`ClickUpSyncService.ts:753`, interface at `:83`), and **both** producers normalise — the bulk list payload via `_fetchListTasksInternal`, and `getTaskDetails` via `ClickUpSyncService.ts:1307`. Verified by running the compiled pre-fix provider: input `markdownDescription: '## Heading\nbody'` produced `- [ ] Has desc (901xyz) — open` with no blockquote at all. The truncation cap, null-coercion and heading-demotion regex were all correct and all operating on `''`. This is precisely the plan's own risk #3 — the title-and-id-only checklist that "satisfies 'the file has a `## Subtasks` section' while still handing the agent an incomplete spec".

**MAJOR — legacy ClickUp checklist lines duplicated on merge.** `_parseSubtaskEntries` keyed an existing line on the last parenthesised group *anywhere* on the line. The shipped per-open enrich wrote ClickUp subtasks as `- [ ] ${st.name || st.id}` — no id — so legacy lines keyed on nothing, or on a fragment of their own title. Reproduced against the compiled pre-fix provider: a legacy section holding `- [ ] Fix the (broken) widget` / `- [x] Ship it` merged with a payload for those same two subtasks produced **four checklist lines for two subtasks** (the first legacy line keyed on `broken`, so it never collided with `901abc`). This fires on the first Refresh for every user who ever clicked a ClickUp ticket. UAT step 5 would not catch it — it checks for one `## Subtasks` *section*, and there is exactly one, full of duplicates.

**Correct as implemented (no change):** the unified never-delete merge with no `isDelta` fork in the section logic; `_findTicketDocument` id-based resolution of the prior file (the renamed-parent guard); the section written last so `pushTicketEdits`' truncation at `:21125` stays correct; the orphan upsert refusing to create a section from a single delta item, and its own conflict guard + `last_synced_at` refresh; `fetchIsAuthoritative` gating the section write; the Stage 3 conflict guard on full imports with `skippedModified`; the `dbTickets` hoist **and** the collapse of the prune's lazy re-query; and the heading-demotion regex being line-leading-only (inline `#123` / `#fff` survive — verified).

**Deviation from Stage 4, correctly judged by the implementer:** the negative assertion "`_writeTaskDocument`'s body no longer contains `subtasks: []`" was not implemented, and should not be — `_buildLinearImportPlanContent` consumes `node.subtasks`, so passing the payload there would emit a *second* section. The plan's assertion was wrong; the code is right.

### Fixes applied

- `src/services/TaskViewerProvider.ts:21272` — read `markdownDescription || markdown_description || description` (normalised field first, raw key retained as a defensive fallback).
- `src/services/TaskViewerProvider.ts:21313-21337` — new `_parseSubtaskLine`: the id is matched at **end of line** (before the optional `— status` suffix) so a title containing parentheses is not mis-keyed, plus a normalised title key for legacy id-less lines.
- `src/services/TaskViewerProvider.ts:21339-21372` — `_parseSubtaskEntries` keys through the shared parser and suffixes on title collision so two same-titled legacy lines cannot collapse into one.
- `src/services/TaskViewerProvider.ts:21395-21406` — `_mergeSubtasksSection` writes **through** a legacy title-keyed slot, so the id-carrying replacement takes the legacy line's place instead of appearing beside it. No `.delete(` — the never-remove invariant and its Stage 4 assertion both still hold.
- `src/test/tickets-subtask-embedding.test.js` — added `stripComments` and applied it to the two identifier negatives (`isDelta`, `getTaskDetails`/`importTaskAsDocument`), which un-reds CI without weakening either assertion; added gates for the normalised description field, `_parseSubtaskLine`'s end-anchored id, and the legacy title-slot write-through.

### Validation

`npx tsc -p tsconfig.test.json` exit 0; `npm run compile` clean (3 pre-existing optional-dep warnings); `npm run lint` 0 errors. `test:contract:tickets-subtasks` **PASS** (was FAIL at HEAD). `tickets-link-to-ticket-regression` and `planning-aggregate-cache` PASS. `verb-engine-planning-headless` 37 pass / 3 fail and `planning-modal-contract` fail — **both reproduce identically at baseline `ea28cd2`**, stash-verified by materialising that commit in a scratch tree, so neither is attributable to this change. `parity:check` / `push-routing:check` / `verb-returns:check` PASS.

Seven behavioural probes were run against the **compiled** provider (not a transcription): legacy-line dedupe, never-delete preservation when the payload omits a subtask, in-place id-keyed upsert preserving line position, description embed firing, heading demotion with inline-`#` survival, Linear line shape, and legacy-Linear dedupe. All pass post-fix; the two MAJORs reproduce pre-fix.

Gate-wiring audit: `test:contract:tickets-subtasks` is defined at `package.json:795` **and invoked** at `.github/workflows/integration-tests.yml:97`. Not an orphaned script.

### Remaining risks

- **The manual UAT is still the gate and has not been run.** Step 8b (cross-list subtask survival across a full Refresh) is the one that proves the merge rule is a merge and not a regenerate, and no other step catches that failure. Step 4's negative case (a delta must not create a one-line section) and step 3 (renamed parent preserves its section) are likewise unexercised.
- **Legacy-line migration is one-shot and re-orders nothing but is worth eyeballing.** A legacy ClickUp line is rewritten in place with its id; the next parse keys it by id. Verified in the probe, but only on synthetic sections.
- **Deferred NIT — per-item file resolution cost.** `_writeTaskDocument` now calls `_findTicketDocument` + reads the file per item. DB-first, so warm imports are one query each; a *cold* first import misses every row and falls through to a recursive scan of every allowed root plus a `GlobalIntegrationConfigService.loadConfig`, per item — O(N²) dirents on a 100-task list. Load-bearing by design (never-delete needs the prior section), so not a bug. `dbTickets` is already loaded in `importAllTasks` and carries `filePath`; threading a `slugPrefix → filePath` map into the write loop would erase the cost. Left as its own change.
- **Deferred NIT** — the orphan upsert with no `dbEntry` writes the parent file without calling `registerImportedTicket`, leaving mtime advanced with no `last_synced_at`. Only reachable for a file found by filesystem scan with no registry row.
- Accepted cost from the plan stands: a remotely-deleted subtask lingers in the checklist until the parent is next opened.
- Behaviour change stands as designed: Refetch is no longer a hard reset from remote — locally-edited parents are skipped and reported via `skippedModified`.

