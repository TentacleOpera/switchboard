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
- [ ] [Provider Sync — Outbound Parity (ClickUp / Linear / Notion)](../plans/provider-sync-outbound-parity.md) — **CODE REVIEWED**
- [ ] [Provider Sync — Inbound Delete (ClickUp / Linear / Notion)](../plans/provider-sync-inbound-delete.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Ship **Outbound Parity first**, then **Inbound Delete**. Soft ordering, not a hard block: the inbound-delete sweep's mid-create race-guard assumes the outbound plan's atomic `notionPageId` round-trip already exists, so a plan whose page is mid-creation isn't mistaken for a deletion. Both build on the merged Remote Sync Refactor seam already in `main` (no dependency on that plan re-running). Both are opt-in gated so the ~4,000 existing installs are unchanged until enabled.

## Review Findings

Reviewed both subtasks in dependency order (outbound then inbound). The outbound engine (gate→`realTimeSyncEnabled`, Notion `createPageForPlan` with atomic id round-trip, all-three fan-out, `deleteSyncEnabled`-gated archive-on-delete in `PlanIngestionEngine.runPurgeSweep`) is correct and byte-compatible — no outbound fixes needed. The inbound sweep needed three fixes, applied in `NotionRemoteProvider.ts` / `LinearRemoteProvider.ts` / `RemoteControlService.ts`: Notion + Linear `reconcileLiveIds` false-complete on a truncated page cap (would flag the un-fetched tail as deletions / cause a probe storm) → report INCOMPLETE when the cap is hit; and the sweep tombstoning auto-archived plans (self-echo of AutoArchiveService's remote archive) → restrict the sweep to `status==='active'`. **Cross-cutting MAJOR remaining risk: none of the three new opt-in flags (`realTimeSyncEnabled`/`deleteSyncEnabled` for Notion, `inboundDeleteEnabled` for all three) has a setter, so the feature is inert until an enablement toggle is added** — the sync mechanism is complete and correct, but unreachable through any current UI/handler path. Compile/tests skipped per session directive.

## Reviewer Completion Report

Executed a direct in-place reviewer pass over both subtasks of this feature. Applied three fixes to the inbound-delete sweep (two `reconcileLiveIds` false-complete guards + an active-only filter to stop the auto-archive self-echo) across `RemoteControlService.ts`, `NotionRemoteProvider.ts`, and `LinearRemoteProvider.ts`; the outbound half required no code changes. The dominant remaining risk is that the feature's opt-in flags have no setter, leaving it unreachable until an enablement UI/handler lands. Verification was static review only (compilation and automated tests skipped per session directive); all fixes are localized and preserve the plans' safety contracts. See each subtask's `## Review Findings` for detail.
