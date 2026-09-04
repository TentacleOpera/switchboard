# Tickets Panel — Stale Checklists and Blank Inline Images

<!-- board-collapse-membership -->
> **MEMBERSHIP CORRECTED 2026-09-04 (Board Collapse audit). One subtask, not two, and the title over-promises.**
> 
> *Tickets Panel: Inline Images Are Blank On First View* moved to the new **Tickets images** feature, which gathers the two inline-image plans that were sitting in two different tickets features. This feature now delivers the checklist prune only.
> 
> Note for that survivor: *Replace embedded subtask content with file references* absorbs its checklist rewrite as a migration step, so coordinate rather than duplicating the strip.


**Complexity:** 6

## Goal

Make the Tickets tab show what is actually true. Two independent divergences between a ticket's locally-persisted state and reality: a parent's embedded Subtasks checklist only ever grows, so a subtask deleted in the tracker keeps its line forever and any agent handed the local markdown plans against work that no longer exists; and inline description images are blank on the first view of every ticket, recovering only when the operator clicks to a different ticket and back. Grouped because both are the same failure shape in the same panel, persisted ticket content that no reconciler ever corrects, and both were declared fixed before because in each case the missing signal is what let the bug survive.

## How the Subtasks Achieve This

- **Prune Deleted Subtasks From A Ticket's Embedded Subtasks Checklist**: hooks the checklist rewrite onto the one path that already *proves* a ticket is gone — a 404 against its own endpoint — so the never-trust-an-absent-payload invariant stays intact. The load-bearing detail: the two trackers key their checklist lines differently, one on a human identifier and one on a UUID, so an id-only matcher is a guaranteed silent no-op on half the tickets with every gate green.
- **Tickets Panel: Inline Images Are Blank On First View**: fixes a three-link chain that four previous attempts all missed by targeting URL *generation* instead. A failed image gets a one-shot retry, scheme-gated because appending a cache-buster to a signed asset URL is a hard 403; the render memo gains a narrow bypass when the pane holds a proven failure; the remote description stops winning the first paint with unloadable URLs; and the asset allow-list resolves through the host seam, without which every image in the browser cockpit resolves to a bare relative reference and 404s permanently.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Prune Deleted Subtasks From A Ticket's Embedded `## Subtasks` Checklist](../plans/feature_plan_20260814161000_tickets-parent-subtask-checklist-never-pruned.md) — **PLAN REVIEWED** — ID: e6a0b248-53e2-45d7-8e30-d27d685bc37c
<!-- END SUBTASKS -->

## Dependencies & sequencing

- No hard ordering constraints. The checklist prune is backend-only (`TaskViewerProvider.ts`); the image recovery is provider plus webview (`TicketsPanelProvider.ts`, `tickets.js`, `sharedUtils.js`, `tickets.html`). They can execute in parallel.
- **Both are the kind of change that ships green and wrong.** The prune's cross-tracker identifier test and the image fix's standalone-host UAT step are each the *only* check that distinguishes a fix from a no-op. Neither is optional, and neither can be substituted by the other host's result.
- Every grep-based assertion in the image subtask must be scoped to `src/webview/tickets.js`, never to `src/webview/` — `planning.js` holds a dead full duplicate of both detail renderers and will answer for the live one in either direction.
- **Cross-feature interaction:** the image subtask adds a marker class to the shared `renderMarkdown` image branch in `sharedUtils.js`, and the standalone *live-preview renderer parity* plan moves four preview surfaces onto that same renderer and edits `tickets.js`. They compose, but land this feature's `sharedUtils.js` edit first if both are in flight.
- Five regression tests are red at HEAD for unrelated reasons. Stash-verify the red set before attributing any failure to this work.

