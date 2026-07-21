# Provider Sync — Full Parity (ClickUp / Linear / Notion)

**Complexity:** 7

## Goal

Make ClickUp, Linear, and Notion fully interchangeable two-way sync targets — create/content/status/delete reflected in both directions, all three active at once. Builds on the merged Remote Sync Refactor seam. Split into an outbound-parity subtask (wiring: gate removal, Notion create/archive, seam routing) and an inbound-delete subtask (net-new reconcile-sweep deletion detection).

## How the Subtasks Achieve This

- **Provider Sync — Outbound Parity**: The wiring half (local board → tracker). Removes the single-active Notion gate so all three providers push simultaneously, wires Notion's existing `createPage` (create-if-missing, mirroring ClickUp's lazy-create-inside-`syncPlan`) and `archiveCard` (archive-on-delete) into the local lifecycle, and routes ClickUp/Linear triggers uniformly through the provider seam. Builds directly on already-merged, already-tested seam capabilities — low/moderate risk, opt-in gated.
- **Provider Sync — Inbound Delete**: The net-new half (tracker → local board). Detects when a mapped card is deleted/archived remotely — which the `RemoteStateDelta` seam has no signal for today — via a reconcile-sweep driven off the existing host-agnostic poll loop, then tombstones the mapped local plan (recoverable, opt-in default-off, never hard-delete, never unmapped). Higher risk; the one part of the feature that is a build, not wiring.

Together they make every cell of the outbound and inbound sync matrices ✅ for all three providers, with no single-active restriction.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Provider Sync — Outbound Parity (ClickUp / Linear / Notion)](../plans/provider-sync-outbound-parity.md) — **LEAD CODED**
- [ ] [Provider Sync — Inbound Delete (ClickUp / Linear / Notion)](../plans/provider-sync-inbound-delete.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Ship **Outbound Parity first**, then **Inbound Delete**. Soft ordering, not a hard block: the inbound-delete sweep's mid-create race-guard assumes the outbound plan's atomic `notionPageId` round-trip already exists, so a plan whose page is mid-creation isn't mistaken for a deletion. Both build on the merged Remote Sync Refactor seam already in `main` (no dependency on that plan re-running). Both are opt-in gated so the ~4,000 existing installs are unchanged until enabled.
