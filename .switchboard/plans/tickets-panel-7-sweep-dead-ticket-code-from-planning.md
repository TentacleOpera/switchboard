# Sweep the dead ticket code left in the Artifacts panel after the Tickets extraction

## Goal

Delete the ticket code stranded in `src/webview/planning.js`, `src/webview/planning.html` and `src/services/PlanningPanelProvider.ts` now that the Tickets panel owns the feature. **No behaviour change** — every line targeted is already unreachable. The deliverable is that a reader grepping `planning.js` for "ticket" finds the Artifacts panel's own concerns, not a second dead implementation.

### Problem and background

The Tickets extraction (plans 1, 3, 4 and slices 2a–2f) moved the whole ticket feature into `tickets.html` / `tickets.js` / `TicketsPanelProvider.ts`. Each slice deliberately left `planning.js`'s copies in place, because Planning's not-yet-moved layers still called them — the alternative was stranding the provider contract, which an early attempt did and which cost three failed passes to unwind. That was the right call at the time. The callers are all gone now, so the copies are pure residue.

Current residue, measured:

| File | Residue |
|---|---|
| `src/webview/planning.js` | 401 `ticket` references, **48** ticket function definitions, **11** `stub — real impl in tickets.js` placeholders |
| `src/webview/planning.html` | 142 `ticket` references, **137** of them inside `<style>`, **0** ticket element ids |
| `src/services/PlanningPanelProvider.ts` | 112 `ticket` references |

### Root cause

Slicing a 4,600-line extraction into six passes means each pass can only delete what no surviving caller needs. The residue is the accumulated tail of six correct decisions, not a mistake — but nobody owns removing it, so it needs its own pass.

### Why this is safe

`planning.html` contains **zero** ticket element ids, so nothing in `planning.js`'s ticket cluster can find a DOM node. The only ticket verb left on the Planning rail is `openTicketsPanel`, which is the cross-panel switch and stays. The code cannot execute.

## Metadata

**Tags:** refactor, cleanup, frontend

**Complexity:** 4

## The one thing that will go wrong if you rush it

**Find the cluster by reachability, not by name.** A `function .*[Tt]icket` grep finds 48 definitions; tracing their callers finds 16 more call sites inside functions whose names contain no "ticket" at all — `_renderDrillDownHeader`, `selectPriority`, `_clickUpAssigneeIdentity`, `_linearAssigneeIdentity`, `_onClickUpStatusFilterChanged`, `loadClickUpTaskDetails`, `loadLinearTaskDetails`. Those are ticket-domain functions too. Name-matching under-counts the cluster, and a partial deletion leaves dangling references.

This is not hypothetical: name-derived rather than caller-traced lists were the single largest source of defects across this whole feature — they sent one coder toward breaking DOCS push-to-source (`syncToSource`), left slice 2d's five shared utility verbs unregistered with a live-broken detail pane, mis-assigned `copyLinearAgentSkill` in plan 4, and missed six panel-level modals across 2a–2f. Trace the graph.

Suggested method: start from the 48 name-matched definitions, walk callers and callees transitively, and stop expanding when you reach something the DOCS / HTML / RESEARCH / WEB AGENTS tabs genuinely use. Anything in the closed set with no edge to a surviving tab is deletable. Write the set down before deleting so the diff is reviewable.

## Scope

### `src/webview/planning.js`

- Delete the closed ticket cluster identified above, including the **11** `stub — real impl in tickets.js` placeholders left by slices 2b and 2c (grep that exact phrase to find them).
- Delete ticket branches in shared code: the tab-switch and sidebar-state paths, and the `persistTab('tickets.root', …)` writes.
- Keep `openTicketsPanel` and the `tickets` → `docs` coercion in `switchToTab` — that is the live cross-panel switch and the no-blank-panel guard.
- **Do not** touch `escapeHtml`, `escapeAttr`, `initOverflowMenus`, `_positionOverflowPopover`, `sanitizeUrl` or `renderMarkdown` — they live in `sharedUtils.js` and `planning.js` correctly has no copies.
- **Do not** delete `normalizeFsPath`, `getCurrentFolderPaths`, `getFolderModalEntries`, `labelForWorkspaceRoot`, `renderFolderListModal` or `openFoldersModal` — the DOCS tab still uses them.

### `src/webview/planning.html`

- Remove the ticket `<style>` rules (137 references). Zero ticket element ids remain, so no markup work.
- Do **not** prune `.sb-icon-*` mask rules without checking: `scripts/check-icon-parity.js` enforces that every *used* class has a rule, not the reverse, so an unused rule will not fail the gate — but a rule still used by a surviving tab will break silently if removed.
- `planning.html` is currently brace-balanced (`<div>` 135 / `</div>` 135). It was **not** for most of this feature's life — two orphan closers from the original lift survived until slice 2f review. Re-check balance after editing.

### `src/services/PlanningPanelProvider.ts`

- Remove ticket helper methods with no surviving caller (112 references to triage). `_findTicketFilePath`, `_rewriteLocalImagePaths` and `_getTicketDocumentDirs` are reached from `sharedUtilityVerbs.ts` via `_sharedUtilityDeps` — **keep those three.**
- `syncToSource` and its `_handleSyncToSource` are the DOCS push-to-source feature, not tickets. Keep.

## Verification Plan

### Automated

- `node --check src/webview/planning.js` — must parse.
- `<div>` / `</div>` balance in `planning.html` must be equal before and after.
- Reference-integrity check: every identifier still called in `planning.js` must resolve to a definition in `planning.js` or `sharedUtils.js`. A dangling call is the signature of a partial cluster deletion and will not fail any existing gate.
- `npm run compile-tests`, `npm run lint` — the only acceptable remaining lint error is `src/webview/terminals.js:1013`, which belongs to the Terminals feature (see its own plan).
- `npm run catalog:generate` then `npm run catalog:check`. Removing webview post sites changes the catalog; run the regen **last**, after all edits. `PLANNING_VERBS` must still contain `openTicketsPanel` and must not lose any DOCS/HTML verb.
- `npm run parity:check`, `npm run push-routing:check`, `npm run verb-returns:check`, `npm run icons:parity`, `npm run mirror:check`.
- Lower the `Planning` ceiling in `scripts/verb-return-contract-baseline.json` to its new actual count — deleting arms reduces the break count and leaving the ceiling high silently widens the allowance.
- Full contract sweep, all of which must stay green: `test:contract:verb-engine`, `verb-engine-planning`, `verb-engine-tickets`, `verb-engine-kanban`, `tickets-subtasks`, `tickets-assignee-filter`, `tickets-sidebar-scoping`, `panel-scrollbars`, `panel-revival-retention`, `shim-injection`, `rendermarkdown`, `secrets-bridge`.
- Check exit codes, not output text. Two suites were reported green during this feature's review on the strength of substring matching when they were in fact failing.

### Manual

- Artifacts panel, both hosts: exercise DOCS (source filters, folder modal, imported-docs push-to-source), HTML (previewer, inspect mode), RESEARCH and WEB AGENTS. This is the panel being edited, so a regression here is the whole risk.
- Tickets panel, both hosts: confirm it is unaffected — nothing in this plan should touch it.
- Confirm clicking a `tickets` deep link or stale state still lands on DOCS without a blank panel.
