# Sweep the dead ticket code left in the Artifacts panel after the Tickets extraction

## Goal

Delete the ticket code stranded in `src/webview/planning.js`, `src/webview/planning.html` and `src/services/PlanningPanelProvider.ts` now that the Tickets panel owns the feature. **No behaviour change** — every line targeted is already unreachable. The deliverable is that a reader grepping `planning.js` for "ticket" finds the Artifacts panel's own concerns, not a second dead implementation.

### Problem and background

The Tickets extraction (plans 1, 3, 4 and slices 2a–2f) moved the whole ticket feature into `tickets.html` / `tickets.js` / `TicketsPanelProvider.ts`. Each slice deliberately left `planning.js`'s copies in place, because Planning's not-yet-moved layers still called them — the alternative was stranding the provider contract, which an early attempt did and which cost three failed passes to unwind. That was the right call at the time. The callers are all gone now, so the copies are pure residue.

Current residue, **re-measured at HEAD** (the plan's original 2026-08-03 figures are superseded below; the counts are case-sensitive `grep -c 'ticket'` line counts, which is how the original table was produced):

| File | Residue at HEAD | As authored 2026-08-03 |
|---|---|---|
| `src/webview/planning.js` | **403** `ticket` lines, **48** ticket-named function definitions, **11** `stub — real impl in tickets.js` placeholders | 401 / 48 / 11 |
| `src/webview/planning.html` | **143** `ticket` lines, **all but 5** inside `<style>`, **0** ticket element ids | 142 / 137 in-style / 0 ids |
| `src/services/PlanningPanelProvider.ts` | **65** `ticket` lines | 112 |

> **Superseded:** `src/services/PlanningPanelProvider.ts` — 112 `ticket` references.
> **Reason:** Re-measured at HEAD on 2026-08-14: the count is **65**, not 112. Roughly half the provider-side residue was removed by later work between plan authoring and now. A coder triaging against "112 references" will assume a much larger surface than exists and may over-delete looking for a phantom remainder.
> **Replaced with:** 65 `ticket` lines in `PlanningPanelProvider.ts`. The full triage of those 65 is enumerated in **Proposed Changes** below — it is small enough to state exhaustively, so state it exhaustively rather than leaving the coder to re-derive it.

The 5 non-`<style>` `ticket` lines in `planning.html` are all **comments** left by slices 2e and 2f recording where the create-ticket modal, status modal, priority popover, attachments modal, Source modal and Agent API modal went (lines 3979–3981, 4012–4013). They document a completed move; they are not markup.

### Root cause

Slicing a 4,600-line extraction into six passes means each pass can only delete what no surviving caller needs. The residue is the accumulated tail of six correct decisions, not a mistake — but nobody owns removing it, so it needs its own pass.

### Why this is safe

`planning.html` contains **zero** ticket element ids, so nothing in `planning.js`'s ticket cluster can find a DOM node. The only ticket verb left on the Planning rail is `openTicketsPanel`, which is the cross-panel switch and stays. The code cannot execute.

Verified at HEAD, two independent confirmations that the cluster is already orphaned:

- `loadClickUpTaskDetails` (`planning.js:8783`) and `loadLinearTaskDetails` (`planning.js:8761`) each occur **exactly once** in the file — the definition, with no caller.
- `_setupTicketsViewWatcher` (`PlanningPanelProvider.ts:7054`), `_ticketSyncStatusFromTimestamps` (`:6964`), `_scanLocalTicketFiles` (`:6979`) and `_findLocalTicketFile` (`:7037`) each occur only as their own definition plus, where applicable, their own recursive self-call. **Zero external callers.** The `setupTicketsWatcher` verb that used to reach them moved to `TicketsPanelProvider` in slice 2c (see the comment at `PlanningPanelProvider.ts:2631`).

## Metadata

**Tags:** refactor, cleanup, frontend, backend

**Complexity:** 6

> **Superseded:** **Complexity:** 4
> **Reason:** 4 is "routine single-file changes". This is a three-file deletion of ~470 lines across a *shipped* panel (~4,000 installs), it crosses the webview↔provider boundary, the deletion set must be computed by reachability rather than read off a grep, and one of the surviving symbols (`_pushTickets`) is a name-collision landmine. The risk is not in any single edit — it is that a partial cluster deletion leaves dangling references that no existing gate catches. That is a 6.
> **Replaced with:** **Complexity:** 6 — mixed. Individually routine deletions, but multi-file, reachability-gated, and on the panel that is the whole regression surface.

## User Review Required

None. Every decision in this plan is settled: the cluster is deletable, the keep-list is enumerated, and the two scope extensions (provider-side dead helpers; the dead cross-boundary push chain) are the same closed set reached from the other end.

## The one thing that will go wrong if you rush it

**Find the cluster by reachability, not by name.** This cuts in both directions, and both directions have bitten this feature before.

**Direction 1 — name-matching under-counts.** A `function .*[Tt]icket` grep finds 48 definitions in `planning.js`. Tracing callers and callees finds a further **fourteen** ticket-domain functions whose names contain no "ticket" at all, verified present at HEAD:

`_linearPriorityColor` (`:928`), `_linearPriorityName` (`:933`), `_clickUpPriorityColor` (`:938`), `_clickUpPriorityName` (`:952`), `_availableClickUpPriorities` (`:966`), `_clickUpAssigneeIdentity` (`:7768`), `_linearAssigneeIdentity` (`:7772`), `getFilteredLinearIssues` (`:7831`), `_isClickUpClosedStatus` (`:8447`), `_onClickUpStatusFilterChanged` (`:8457`), `getFilteredClickUpTasks` (`:8531`), `loadLinearTaskDetails` (`:8761`), `loadMoreClickUpTasks` (`:8770`), `loadClickUpTaskDetails` (`:8783`) — plus `_renderDrillDownHeader` and `selectPriority`, which are ticket-detail rendering.

> **Superseded:** "tracing their callers finds 16 more call sites inside functions whose names contain no 'ticket' at all — `_renderDrillDownHeader`, `selectPriority`, `_clickUpAssigneeIdentity`, `_linearAssigneeIdentity`, `_onClickUpStatusFilterChanged`, `loadClickUpTaskDetails`, `loadLinearTaskDetails`."
> **Reason:** The original listed seven names for a claimed sixteen sites, leaving the coder to find the other nine. All sixteen are enumerable and were enumerated at HEAD; leaving the list partial is exactly the "name-derived rather than caller-traced" failure the section warns against.
> **Replaced with:** The full sixteen, listed above with line numbers. Each was checked for external reach: none is referenced from `planning.html` (0 occurrences each) and each occurs only 2–5 times in `planning.js` — definition plus internal cluster callers.

**Direction 2 — name-matching over-counts, and this one deletes working code.** `PlanningPanelProvider.ts` declares `private _pushTickets: Map<string, number>` (`:212`) with helper logic at `:216–241`. **This is not the ticket feature.** It is the per-key push-race token — the provider assigns a monotonic ticket per push key and returns a predicate reporting whether a given call is still the newest. Four occurrences, all live, all load-bearing for push-race correctness. A `grep -i ticket | delete` pass removes it and silently reintroduces the stale-push race it exists to prevent. **Keep `_pushTickets` and everything at `:211–241`.**

This is not hypothetical: name-derived rather than caller-traced lists were the single largest source of defects across this whole feature — they sent one coder toward breaking DOCS push-to-source (`syncToSource`), left slice 2d's five shared utility verbs unregistered with a live-broken detail pane, mis-assigned `copyLinearAgentSkill` in plan 4, and missed six panel-level modals across 2a–2f. Trace the graph.

Suggested method: start from the 48 name-matched definitions plus the sixteen listed above, walk callers and callees transitively, and stop expanding when you reach something the DOCS / HTML / RESEARCH / WEB AGENTS tabs genuinely use. Anything in the closed set with no edge to a surviving tab is deletable. **Write the set down before deleting so the diff is reviewable.**

## Complexity Audit

### Routine

- Deleting the 11 `stub — real impl in tickets.js` placeholders (`planning.js:1224–1234`) — zero-body functions, nothing to reason about.
- Deleting the ticket `<style>` block in `planning.html` — no markup, no ids, no handlers.
- Deleting the four provider-side helpers with zero callers (`_setupTicketsViewWatcher`, `_ticketSyncStatusFromTimestamps`, `_scanLocalTicketFiles`, `_findLocalTicketFile`).
- Re-checking `<div>`/`</div>` balance after the HTML edit.

### Complex / Risky

- **Computing the closed cluster.** The deletion set is a graph closure, not a grep result. Both under- and over-counting have concrete, already-observed failure modes (above).
- **The `_pushTickets` name collision** — the one symbol in the file that matches `ticket` and must survive untouched.
- **Cross-boundary residue.** The dead code is not confined to the three named files' interiors: `PlanningPanelProvider` still *computes and pushes* payloads that no surviving `planning.js` consumer reads (see Proposed Changes → cross-boundary chain). Deleting only the webview half leaves a provider doing work for nobody; deleting only the provider half leaves a webview arm waiting on a message that never arrives. They must move together.
- **`stripImportedSubtasksBlock`'s only use is inside a function this plan deletes** (`PlanningPanelProvider.ts:7091`, inside `_setupTicketsViewWatcher`). Its import at `:54` becomes unused and will fail lint if left. Easy to miss because the import line does not contain the word "ticket" in a way a scoped grep surfaces.
- **This is the panel being edited.** A regression here is not a ticket regression — it is a DOCS / HTML / RESEARCH / WEB AGENTS regression on a shipped panel.
- **The verb-return ratchet must be lowered in the same change.** Removing arms lowers the true `break` count; leaving `"Planning": 152` in the baseline silently widens the allowance for future work.

## Edge-Case & Dependency Audit

### Race Conditions

- None introduced — this plan only removes code. The one race-adjacent construct in scope, `_pushTickets`, is explicitly preserved.

### Security

- No new surface. `_getTicketDocumentDirs`, `_findTicketFilePath` and `_scanForTicketFile` participate in `localResourceRoots` / image-path resolution and are on the **keep** list; do not narrow them speculatively.
- `ticketsFolderPathsByRoot` (`:5777–5878`, 5 occurrences, all live) feeds the webview's allowed image roots. **Keep.** Removing it 403s screenshots in surviving tabs.

### Side Effects

- Removing webview post sites changes the generated verb catalog. `npm run catalog:generate` must run **last**, after every edit.
- The `Planning` entry in `scripts/verb-return-contract-baseline.json` is currently **152**. It must be lowered to the true post-deletion residual reported by `analyze-verb-migration2.js`. Per the project PRD, ceilings only ever ratchet down, and legitimate nested-control-flow `break`s must stay — do not force it to 0.
- Deleting `_setupTicketsViewWatcher` removes the last consumer of the `stripImportedSubtasksBlock` import; remove the import too.

### Dependencies & Conflicts

- **No file overlap with the sibling subtask.** This plan edits `planning.js`, `planning.html`, `PlanningPanelProvider.ts`. The sibling (`tickets-panel-8-single-source-for-tickets-root`) edits `tickets.js` and `TicketsPanelProvider.ts`. Disjoint — they can be coded in parallel by different agents without violating the PRD's "one agent stream per provider file" rule.
- **`tickets.root` is the one shared concept.** This plan deletes `planning.js`'s `persistTab('tickets.root', …)` writers. The sibling's migration (`TicketsPanelProvider._migrateTicketsRootFromPlanning`) *reads* the planning panel's persisted `tickets.root` value. **These do not conflict:** the migration reads the VS Code memento key `switchboard.panelState.planning.tickets.root.panel` directly via `new PanelStateStore(globalState, 'planning')`. Deleting the code that *wrote* that key does not erase values already persisted on shipped installs, which is the entire population the migration exists for. Deleting the writer is in fact the correct end-state: the legacy key becomes read-only history.
- **Do not delete the persisted value or add any cleanup that clears it.** Not in scope, and it would break the sibling's migration for every user who has not yet upgraded past it.
- `scripts/check-icon-parity.js` enforces that every *used* `.sb-icon-*` class has a rule, not the reverse — an unused rule will not fail the gate, but a rule still used by a surviving tab breaks silently if removed.

## Dependencies

- No prior agent sessions to reference; this plan was authored standalone and re-verified against HEAD on 2026-08-14.
- Sibling subtask `tickets-panel-8-single-source-for-tickets-root` — related by the `tickets.root` concept only, not by file. No ordering constraint in either direction (see Dependencies & Conflicts).

## Adversarial Synthesis

Key risks: (1) the deletion set is computed by name rather than by reachability, which either strands dangling references or deletes `_pushTickets` and reopens a push race; (2) the cross-boundary push chain is only half-removed, leaving a provider computing payloads nobody reads or a webview arm awaiting a message nobody sends; (3) the Planning verb-return ceiling is left at 152, silently widening the allowance. Mitigations: write down the closed set before deleting and review the set rather than the diff; treat the provider and webview halves of each dead chain as one atomic edit; lower the ratchet in the same change; run `catalog:generate` last and verify by exit code, not by matching output text.

## Proposed Changes

### `src/webview/planning.js`

**Context.** 9,236 lines; 403 carry a `ticket` reference. 48 ticket-named function definitions plus the sixteen non-ticket-named cluster members enumerated above. Zero of them can reach a DOM node — `planning.html` has no ticket element ids.

**Logic.** Delete the closed cluster. Seed the closure from the 48 + 16; expand transitively over callers and callees; stop at any symbol with an edge to DOCS, HTML, RESEARCH or WEB AGENTS.

**Implementation.**

- Delete the **11** stub placeholders at `:1224–1234` (`renderTicketsTab`, `saveTicketsState`, `loadClickUpSpaces`, `loadLinearProject`, `loadClickUpProject`, `showMoveTicketModal`, `updateTicketsSourceSummary`, `resetTicketsInMemoryState`, `restoreTicketsStateForRoot`, `restoreTicketsState`, `exitMoveMode`). Grep the exact phrase `stub — real impl in tickets.js` to confirm all 11 are gone.
- Delete the ticket branch of the `restoredTabState` arm, `:4207–4230`. This block reads `_restoredPanelState.panel['tickets.root']`, sets `ticketsWorkspaceRoot`, writes a dropdown that no longer exists (`document.getElementById('tickets-workspace-filter')` — no such id in `planning.html`), and posts `ticketsRootChanged` / `ticketsDefaultRoot` to a provider that no longer has those arms (moved to `TicketsPanelProvider` in slice 2c; see `PlanningPanelProvider.ts:2631`). Two of its inner branches are already empty stubs carrying only a `── 2b: restoreTicketsStateForRoot moved to tickets.js ──` comment. **Keep** the `research.root`, `kanban.root`, `kanban.project` and `resolveDocsWorkspaceFilter` handling in the same arm (`:4231–4256`) — that is live Artifacts-panel state.
- Delete `updateTicketsWorkspacePicker` (`:7313`) together with its two call sites (`:4200`, `:7361`) and the state it reads: `_integrationWorkspaces` (`:73`) and `_integrationWorkspacesReceived` (`:78`). The whole `case 'integrationWorkspaces'` arm (`:4197–4202`) exists only to call it.
- Delete the dead `integrationProviderStates` re-dispatch at `:4183–4187` and its flag `_integrationProviderStatesReceived` (`:79`). The `case 'integrationProviderStates'` arm it dispatches into **was already removed** in slice 2b (see the comment at `:5184`), so this dispatch fires a message into a handler that does not exist.
- Delete the `persistTab('tickets.root', …)` writes and any remaining tab-switch / sidebar-state ticket branches.
- **Keep** `openTicketsPanel` (`:1707`) and the `tickets` → `docs` coercion in `switchToTab` — that is the live cross-panel switch and the no-blank-panel guard.
- **Do not** touch `escapeHtml`, `escapeAttr`, `initOverflowMenus`, `_positionOverflowPopover`, `sanitizeUrl` or `renderMarkdown` — they live in `sharedUtils.js`. (Note: `escapeHtml`, `escapeAttr` and `renderMarkdown` *do* appear in `planning.js` at high counts — 66, 31 and 11 — but as **call sites**, not definitions. Delete the ticket-cluster call sites along with their callers; never the shared definitions.)
- **Do not** delete `normalizeFsPath` (13 uses), `getCurrentFolderPaths` (12), `getFolderModalEntries` (2), `labelForWorkspaceRoot` (2), `renderFolderListModal` (6) or `openFoldersModal` (3) — the DOCS tab still uses them.

**Edge cases.** After deletion, every identifier still called in `planning.js` must resolve to a definition in `planning.js` or `sharedUtils.js`. A dangling call is the signature of a partial cluster deletion and no existing gate catches it — see Verification Plan.

### `src/webview/planning.html`

**Context.** 4,050 lines; 143 carry a `ticket` reference, all but 5 inside `<style>`. The 5 exceptions are slice 2e/2f comments at `:3979–3981` and `:4012–4013` recording where the modals went. Zero ticket element ids.

**Logic.** Remove the ticket `<style>` rules. No markup work — there is none to do.

**Implementation.**

- Delete the ticket CSS rules from the `<style>` block.
- Delete the six now-historical move comments at `:3979–3981` and `:4012–4013` — the code they annotate is gone from this file and they only send the next reader looking for markup that is not there.
- Do **not** prune `.sb-icon-*` mask rules without checking each against surviving usage: `scripts/check-icon-parity.js` enforces used→rule, not rule→used, so an unused rule will not fail the gate but a still-used rule breaks silently.

**Edge cases.** `planning.html` is currently brace-balanced (`<div>` 124 / `</div>` 124). It was **not** for most of this feature's life — two orphan closers from the original lift survived until slice 2f review. Re-check balance after editing.

> **Superseded:** "`planning.html` is currently brace-balanced (`<div>` 135 / `</div>` 135)."
> **Reason:** Re-measured at HEAD: the file is 124 / 124, not 135 / 135. Still balanced — the invariant holds and the warning stands — but a coder diffing against 135 will think eleven `<div>`s went missing.
> **Replaced with:** 124 / 124 at HEAD. The check is that open == close before and after, not that either equals a fixed number.

### `src/services/PlanningPanelProvider.ts`

**Context.** 7,342 lines; **65** carry a `ticket` reference. Small enough to triage exhaustively, and triaged exhaustively below.

**Logic.** Remove the ticket helpers with no surviving caller, and the provider half of the two dead cross-boundary push chains. Keep everything reached from `_sharedUtilityDeps`, everything serving DOCS, and the push-race token.

**Implementation — DELETE (verified zero external callers at HEAD):**

- `_setupTicketsViewWatcher` (`:7054–7113`) — 1 occurrence in the file: its own definition. Its verb moved to `TicketsPanelProvider` in slice 2c. Deleting it also removes the `ticketFileChanged` push at `:7095` and the `handleTicketFileEvent` closure.
- `_ticketsViewWatcher` (`:267`) and `_ticketsViewWatcherDebounces` (`:268`) — state owned solely by the above.
- `_ticketSyncStatusFromTimestamps` (`:6964`) — 1 occurrence: its own definition.
- `_scanLocalTicketFiles` (`:6979`) — 2 occurrences: definition plus its own recursive call at `:6987`.
- `_findLocalTicketFile` (`:7037`) — 2 occurrences: definition plus its own recursive call at `:7045`.
- The `stripImportedSubtasksBlock` import at `:54` — its only use is at `:7091`, inside `_setupTicketsViewWatcher`. Once that function is gone the import is unused and lint fails. **Remove the import in the same edit.**

**Implementation — the cross-boundary chain (delete with the `planning.js` half, atomically):**

- `_activeTicketsProvider` (`:287`) and its uses at `:2587` and `:2597`, together with the `integrationProviderStates` computation and push inside `fetchRoots` (`:2580–2601`) and the `integrationProviderStates` key in the `fetchRootsComplete` return body. `planning.js`'s consuming arm was removed in slice 2b; the dispatch that survives on the webview side (`planning.js:4183–4187`) targets a handler that no longer exists. Both ends are dead.
- The `integrationWorkspaces` push and `_getIntegrationWorkspaces()` call inside `fetchRoots`, plus the `integrationWorkspaces` key in the return body. Its only webview consumer is `updateTicketsWorkspacePicker`, deleted above.
- The `'tickets'` and `'tickets.root'` entries in the `tabKeys` array at `:2554`. After the `planning.js` deletions nothing on the Artifacts panel reads either key. **This does not affect the sibling subtask's migration** — that reads the memento key directly, not this payload (see Edge-Case & Dependency Audit).

**Implementation — KEEP (each verified reachable at HEAD):**

- `_pushTickets` and the push-race helpers at `:211–241`. **Not the ticket feature.** See "The one thing that will go wrong".
- `_findTicketFilePath` (`:2270`), `_scanForTicketFile` (`:2317`), `_getTicketDocumentDirs` (`:2194`) and `_rewriteLocalImagePaths` (`:2387`) — all four are reached from `sharedUtilityVerbs.ts` via `_sharedUtilityDeps` (`:2499–2504`). `_rewriteLocalImagePaths` has a second use at `:7090` inside the deleted watcher; the `:2502` use is the live one, so the **function stays**.
- `ticketsFolderPathsByRoot` (`:5777–5878`) — feeds `localResourceRoots` / allowed image roots for surviving tabs.
- The `ticketSaveLocation` reads at `:5625–5632` and `:7064–7069` — the `:7064` pair dies with the watcher; the `:5625` pair is the DOCS folder-URI path and stays.
- `syncToSource` and `_handleSyncToSource` — the DOCS push-to-source feature, not tickets.
- `openTicketsPanel` (`:4793–4799`) — the cross-panel switch.
- Every `── 2b/2c/2d/2e/2f: … moved to TicketsPanelProvider ──` breadcrumb comment. These are the extraction's own audit trail and cost nothing; leaving them prevents a future reader re-deriving where each verb went. (Contrast with the `planning.html` move-comments, which are deleted because they point at markup in a file that no longer contains any.)

**Edge cases.** The provider is a shipped-install surface (~4,000 installs). Every deletion above is dead code, so no migration is required — but confirm each caller count at HEAD before deleting rather than trusting this list, because the file moved substantially between plan authoring and now (112 → 65 references).

### `scripts/verb-return-contract-baseline.json`

Lower the `"Planning"` ceiling from its current **152** to the true post-deletion residual reported by `analyze-verb-migration2.js`, **in this same change**. Per the project PRD the ratchet only ever moves down and nested-control-flow `break`s legitimately remain — do not force it to 0.

## Verification Plan

### Automated Tests

- `node --check src/webview/planning.js` — must parse.
- `<div>` / `</div>` balance in `planning.html` must be equal before and after (124 / 124 at HEAD).
- **Reference-integrity check** — every identifier still called in `planning.js` must resolve to a definition in `planning.js` or `sharedUtils.js`. A dangling call is the signature of a partial cluster deletion and **will not fail any existing gate**. This is the single highest-value check in the plan; run it even though nothing enforces it.
- Grep `stub — real impl in tickets.js` in `planning.js` — must return 0 (was 11).
- Grep `_pushTickets` in `PlanningPanelProvider.ts` — must still return **4**. A 0 here means the name-collision trap fired.
- `npm run compile-tests`, `npm run lint` — the only acceptable remaining lint error is `src/webview/terminals.js:1013`, which belongs to the Terminals feature (see its own plan). An unused-import error on `stripImportedSubtasksBlock` means step 6 of the provider edits was missed.
- `npm run catalog:generate` then `npm run catalog:check`. Removing webview post sites changes the catalog; run the regen **last**, after all edits. `PLANNING_VERBS` must still contain `openTicketsPanel` and must not lose any DOCS/HTML verb.
- `npm run parity:check`, `npm run push-routing:check`, `npm run verb-returns:check`, `npm run icons:parity`, `npm run mirror:check`.
- Full contract sweep, all of which must stay green: `test:contract:verb-engine`, `verb-engine-planning`, `verb-engine-tickets`, `verb-engine-kanban`, `tickets-subtasks`, `tickets-assignee-filter`, `tickets-sidebar-scoping`, `panel-scrollbars`, `panel-revival-retention`, `shim-injection`, `rendermarkdown`, `secrets-bridge`.
- **Check exit codes, not output text.** Two suites were reported green during this feature's review on the strength of substring matching when they were in fact failing.

### Manual

- Artifacts panel, both hosts: exercise DOCS (source filters, folder modal, imported-docs push-to-source), HTML (previewer, inspect mode), RESEARCH and WEB AGENTS. This is the panel being edited, so a regression here is the whole risk.
- Tickets panel, both hosts: confirm it is unaffected — nothing in this plan should touch it.
- Confirm clicking a `tickets` deep link or stale state still lands on DOCS without a blank panel.
- Confirm no console errors on Artifacts panel open in either host. A dangling reference from a partial deletion surfaces here first, as a `ReferenceError` at panel init.

---

**Recommendation:** Send to Coder (complexity 6).
