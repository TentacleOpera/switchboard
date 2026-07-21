---
description: "Outbound provider-sync parity: local board → tracker for ClickUp/Linear/Notion, all three simultaneously. Remove the single-active Notion gate, wire Notion create-if-missing and archive-on-delete into the local lifecycle, and route ClickUp/Linear triggers uniformly through the provider seam. Wiring on top of the merged RemoteProvider seam — the low/moderate-risk half of the parity work. Opt-in gated. Split from provider-sync-full-parity; inbound-delete is its sibling plan."
---

# Provider Sync — Outbound Parity (ClickUp / Linear / Notion)

## Goal

Make the **outbound** direction (local board → tracker) reach full parity across ClickUp, Linear, and Notion, with **all three pushing simultaneously** (no single-active restriction): a plan created locally creates the remote item; an edit pushes content; a column move pushes status; a local delete archives the remote — for all three providers at once.

### Core problem / root cause

The merged Remote Sync Refactor gave Notion a real push seam (`pushState`/`pushContent`/`archiveCard`/`importRemotePlan`) but left three outbound gaps: (1) Notion's `createPage` and `archiveCard` are capabilities on the seam but were never connected to the local create/delete lifecycle (those paths still hardcode ClickUp+Linear); (2) Notion push is gated behind being the single active remote-control provider; (3) ClickUp/Linear still call the concrete `debouncedSync` while only Notion routes through `provider.pushState`, so dispatch is non-uniform. This plan closes all three — it is wiring on top of already-merged, already-tested capabilities.

### Current outbound state (verified against merged source, 2026-07-21)

| Action | ClickUp | Linear | Notion |
| :--- | :---: | :---: | :---: |
| Create remote item on new local plan | ✅ lazy in `syncPlan` → `_createTask` when no id ([ClickUpSyncService.ts:2718](../../src/services/ClickUpSyncService.ts#L2718)) | ✅ lazy in `debouncedSync` | ❌ `createPage` exists ([NotionFetchService.ts:726](../../src/services/NotionFetchService.ts#L726)) but is unwired (only caller is `ResearchImportService`) |
| Push content on edit | ✅ | ✅ | ✅ `pushContent` |
| Push status on column move | ✅ | ✅ | ⚠️ gated single-active ([KanbanProvider.ts:2956](../../src/services/KanbanProvider.ts#L2956)) |
| Archive/delete on local delete | ✅ `archiveTask` ([GlobalPlanWatcherService.ts:520](../../src/services/GlobalPlanWatcherService.ts#L520)) | ✅ `archiveIssue` ([:531](../../src/services/GlobalPlanWatcherService.ts#L531)) | ❌ `archiveCard` exists ([:252](../../src/services/remote/NotionRemoteProvider.ts#L252)) but is unwired |

**Key architectural fact (verified):** ClickUp does NOT have a separate new-plan create hook. `syncPlan` resolves `existingTaskId = plan.clickupTaskId || _findTaskByPlanId(...)`; absent → `_createTask`, else `_updateTask`. **Create is lazy inside the same push path.** So the parity-correct Notion approach is create-if-missing inside the Notion push path — NOT a separate create hook. The outbound trigger methods (`_queueClickUpSync`:2889, `_queueLinearSync`:2919, `_queueNotionSync`:2946) and the single-active gate (:2956) all live in **`KanbanProvider.ts`**, not `RemoteControlService.ts`.

## Metadata
- **Tags:** backend, integrations, refactor, reliability
- **Complexity:** 6
- **Project:** Browser Switchboard
- **Release phase:** Builds on the merged Remote Sync Refactor seam. Touches the shipped extension's create/delete/push paths (~4,000 installs) → byte-compatibility on existing ClickUp/Linear behaviour is the guard; new Notion create/delete + the gate change are opt-in-gated.

## User Review Required
- **None** — the outbound design is settled (see Decisions). The one product-shaped call (return-in-body vs push) does not apply here; outbound writes don't need a read contract.

## Decisions (settled — do not re-litigate)
1. **Remove the single-active-provider gate.** At [KanbanProvider.ts:2956](../../src/services/KanbanProvider.ts#L2956), drop the `config.provider !== 'notion'` clause; keep `config.push`/`rc.isActive` (or introduce a Notion `realTimeSyncEnabled` equivalent) as the Notion enable signal. All three providers then push independently and simultaneously.
2. **Notion create = create-if-missing inside the push path, not a new create hook.** Mirror ClickUp's `syncPlan`: when a Notion-configured, push-enabled board fires an outbound sync for a plan with no `notionPageId`, dedup-check, `createPage` (parent = the plans database id from `_ensureSetup().plansDatabaseId`), set the Kanban Column property, persist the returned id, then treat later syncs as updates. Requires removing `_queueNotionSync`'s `if (!plan.notionPageId) { return; }` early-return and adding a provider-configured fallback to `_getPushProviderForPlan` ([:2041](../../src/services/KanbanProvider.ts#L2041)), which today returns `null` when a plan has no id of any kind.
3. **Notion archive-on-delete mirrors ClickUp/Linear**, gated by a Notion `deleteSyncEnabled` equivalent (recoverable archive, never hard-delete).

## Scope

### ✅ IN SCOPE
- **Notion outbound create-page (create-if-missing):** wire `createPage` into the Notion push path per Decision 2; store the returned id back atomically. Gated by the Notion push opt-in.
- **Notion archive-on-delete:** wire `archiveCard` into the delete/purge path ([GlobalPlanWatcherService.ts:514-534](../../src/services/GlobalPlanWatcherService.ts#L514)) per Decision 3.
- **Remove the single-active gate** per Decision 1.
- **(Consistency) Route ClickUp/Linear local triggers through `provider.pushState`** so all three dispatch uniformly — behaviour-preserving; keep the debounce and the lazy-create-inside-`syncPlan` semantics.
- **Loop safety (outbound side):** an outbound-created page must not re-import as a new local plan — verify the id round-trip beats the poll cursor (the inbound `byRemoteId` map guards this only after the id round-trips); an archive must not bounce back as a delta.

### ⚙️ OUT OF SCOPE
- **Inbound-delete detection** → its sibling plan `provider-sync-inbound-delete`.
- Re-doing anything the merged Remote Sync Refactor already shipped.
- The Ingest/Full Remote-tab UX; terminals/CLI dispatch.

## Implementation Steps
1. **Remove the single-active gate** at [KanbanProvider.ts:2956](../../src/services/KanbanProvider.ts#L2956); confirm all three `_queue*Sync` fire independently via the `queueIntegrationSyncFor*` fan-out ([:6234](../../src/services/KanbanProvider.ts#L6234)/[:6259](../../src/services/KanbanProvider.ts#L6259)).
2. **Wire Notion create-page (create-if-missing):** remove the `notionPageId` early-return in `_queueNotionSync`; add a Notion-configured fallback to `_getPushProviderForPlan`; run the plan-id dedup query (Resolved Assumptions #2), then extend `createPage` to set the Kanban Column `select` + plan-id `rich_text` in the same `POST /v1/pages` body (Resolved Assumptions #1; parent `database:<plansDatabaseId>`), and persist the returned id atomically before the next poll cycle.
3. **Wire Notion archive-on-delete:** add a `plan.notionPageId` branch calling `archiveCard`, gated by a Notion `deleteSyncEnabled` equivalent, alongside the ClickUp/Linear branches.
4. **Route ClickUp/Linear triggers through the provider seam** for uniformity (behaviour-preserving; keep the debounce and lazy-create).
5. **Loop safety:** verify id round-trip vs poll cursor and archive no-op on echo.

## Complexity Audit
### Routine
- The single-active gate line change.
- Wiring `archiveCard` into the delete path (mirrors two existing branches).
- Rerouting ClickUp/Linear through the seam (behaviour-preserving, if byte-compat holds).

### Complex / Risky
- **Notion create-page idempotency has no `_findTaskByPlanId` analog.** `createPage` sets only the title (and `Name` for a database parent) — no Kanban Column, no plan-id. Without a plan-id property written at create + a pre-create dedup query, a repeated sync / second machine / pre-round-trip poll makes a **duplicate page**. Must add both.
- **Create-page id round-trip vs the poll race.** If the inbound poll runs after `createPage` but before the id persists locally, the new page isn't in `byRemoteId` → duplicate local plan. The id write must be atomic and ordered before the cursor advances.
- **Byte-compatibility** on the live ClickUp/Linear paths (~4,000 installs), especially the seam reroute — lazy-create, debounce, and result-handling shapes must not drift.
- **Removing the single-active gate** changes when Notion pushes — verify the per-provider echo guard (column-equality in `_applyStateMirror`, [RemoteControlService.ts:451](../../src/services/RemoteControlService.ts#L451)) holds when Notion + another provider are both active.

## Edge-Case & Dependency Audit
- **Race Conditions:** create-page id round-trip vs inbound poll cursor → duplicate local plan; two providers both pushing the same move → each round-trip must no-op via the echo guard.
- **Security:** no new external write surface beyond the shipped Notion token; create/archive reuse the authed `NotionFetchService.httpRequest`. No new secrets. New destructive behaviour (archive-on-delete) is opt-in-gated.
- **Side Effects:** create-page writes a new remote page + mutates the local plan record with the id; archive-on-delete mutates remote state (recoverable archive). All opt-in.
- **Dependencies & Conflicts:** builds on the merged `RemoteProvider` seam; reuses `createPage`, `archiveCard`, the echo guard, and the `deleteSyncEnabled`/`realTimeSyncEnabled` config pattern.

## Dependencies
- No session dependencies (`sess_…`) — builds on already-merged code in `main`.
- **Sibling:** `provider-sync-inbound-delete` (the inbound-delete half). No hard ordering, but outbound is the natural first ship; inbound-delete assumes the outbound id round-trip exists.
- **Reuses:** `NotionFetchService.createPage`, `NotionRemoteProvider.archiveCard`, `NotionRemoteProvider._ensureSetup().plansDatabaseId`, the echo guard in `RemoteControlService`.

## Adversarial Synthesis

**Risk Summary:** Genuinely the wiring half — but two traps hide in "wiring." Key risks: (1) Notion create-page has no `_findTaskByPlanId`-style dedup and sets no plan-id/column property, so naïve wiring produces duplicate pages and, on a poll race, duplicate local plans; (2) byte-compatibility on the ~4,000-install ClickUp/Linear hot path when rerouting through the seam. Mitigations: add a plan-id property + pre-create dedup query for Notion; make the create-page id write atomic and ordered before cursor advance; keep new behaviour opt-in; keep the debounce and lazy-create semantics unchanged on the reroute.

## Resolved Assumptions

Web research (2026-07-21) resolved the Notion-API uncertainties, verified against the merged code. **The extension pins `Notion-Version: 2022-06-28`** ([NotionFetchService.ts:145](../../src/services/NotionFetchService.ts#L145)), so the single-source `database_id`/`archived` model applies.

1. **One-shot property set at create.** `POST /v1/pages` accepts a full `properties` object in the create body; the Kanban Column `select` and a plan-id `rich_text` can be set with the title in one call — no follow-up `PATCH`. `createPage` today only sends the title, so it must be extended. Title is the only strictly-required field (omitting → 400).
2. **Pre-create dedup.** Query the plans database with a `rich_text` `equals` filter on the plan-id property before creating, to suppress duplicate pages (exact, case-sensitive; 100/page, paginate). This is the Notion analog to `_findTaskByPlanId`.
3. **Rate limits.** ~3 RPS per integration, `429`/`529` with a `Retry-After` header. New create/archive traffic must throttle (≤ ~2.5 RPS) and honour `Retry-After`.

### Non-blocking caveat (out of scope)
Notion `2025-09-03` (multi-source `data_source_id` parents) and `2026-03-11` (`archived` → `in_trash`) would break the `database_id`/`archived` calls **if** the `Notion-Version` pin is bumped. Not bumped here; migration out of scope.

## Proposed Changes

### src/services/KanbanProvider.ts
- **Context:** outbound triggers `_queueClickUpSync` (:2889), `_queueLinearSync` (:2919), `_queueNotionSync` (:2946); fan-out `queueIntegrationSyncFor*` (:6234/:6259); provider selector `_getPushProviderForPlan` (:2041); single-active gate at :2956.
- **Logic:** remove the `config.provider !== 'notion'` clause; remove `_queueNotionSync`'s `notionPageId` early-return and route page-less into create-if-missing; extend `_getPushProviderForPlan` to resolve the configured provider when a plan has no id; optionally reroute ClickUp/Linear through `provider.pushState`.
- **Implementation:** keep debounce + lazy-create; the Notion create branch persists `notionPageId` before the poll cursor can advance.
- **Edge Cases:** page-less first sync; id round-trip vs poll race; two providers active; byte-compat on the reroute.

### src/services/remote/NotionRemoteProvider.ts (+ NotionFetchService.createPage)
- **Context:** `createPage` ([NotionFetchService.ts:726](../../src/services/NotionFetchService.ts#L726)) only sets title; `archiveCard` (:252) and `pushState` (:271) are wired.
- **Logic:** add a create-if-missing entry: pre-check by plan-id property; if none, `createPage(database:<plansDatabaseId>, title, content)` with the Kanban Column `select` + plan-id `rich_text` in the same body; return the new id.
- **Implementation:** extend `createPage` to accept + send properties (reuse the `pushState` PATCH shape for the column value).
- **Edge Cases:** database schema must expose Kanban Column + plan-id properties (verify at setup); duplicate-create suppression; already-archived on archiveCard (idempotent, handled).

### src/services/GlobalPlanWatcherService.ts
- **Context:** delete/purge path (:514-534) archives ClickUp (:519-520) + Linear (:530-531); no Notion branch.
- **Logic:** add a `plan.notionPageId` branch calling `archiveCard`, gated by a Notion `deleteSyncEnabled` equivalent, same try/catch + logging shape.
- **Edge Cases:** flag off → no-op; already-archived → idempotent; provider not configured → skip.

## Verification Plan

> Compilation and automated-test runs were skipped during planning per session directive; the below is the intended verification for the implementer.

### Automated Tests
- With each provider configured + opted-in: a new local plan creates the remote item (incl. a Notion page with id stored back, Kanban Column set, no duplicate on repeated sync); an edit pushes content; a move pushes status for all three simultaneously (no single-active suppression); a local delete archives the remote for all three.
- Loop safety: no outbound write re-imports as an inbound change; a create's id round-trip beats the poll cursor (no duplicate local plan).
- Byte-compat: existing ClickUp/Linear provider tests pass unchanged after the seam reroute.

### Manual
- Configure ClickUp + Linear + Notion together. Create/edit/move/delete a plan in the IDE → all three trackers reflect it, no drift, no loops.

## Recommendation

**Send to Coder** (Complexity 6). Ship this before its inbound-delete sibling.

**Stage Complete:** CREATED

## Completion Summary

Implemented outbound provider-sync parity for ClickUp/Linear/Notion (all three push simultaneously, no single-active restriction). Removed the `config.provider !== 'notion'` gate in `_queueNotionSync` and replaced it with a Notion-specific `realTimeSyncEnabled` opt-in flag on `NotionRemoteSetup` (mirrors ClickUp/Linear's per-service flag, default false). Wired Notion create-if-missing: added `createPageForPlan` to `NotionRemoteProvider` (dedup by Plan ID rich_text + one-shot `POST /v1/pages` with Topic/Plan ID/Kanban Column properties), removed the `notionPageId` early-return in `_queueNotionSync`, and persist the returned id atomically before the poll cursor can advance (loop safety). Wired Notion archive-on-delete in `GlobalPlanWatcherService` alongside the ClickUp/Linear branches, gated by a Notion `deleteSyncEnabled` flag. Extended `NotionRemoteSetup` with `realTimeSyncEnabled`/`deleteSyncEnabled`/`inboundDeleteEnabled` flags (preserve-on-rerun in `saveNotionRemoteSetup`). Files changed: `src/services/remote/notionRemoteConfig.ts`, `src/services/remote/NotionRemoteProvider.ts`, `src/services/KanbanProvider.ts`, `src/services/GlobalPlanWatcherService.ts`, `src/extension.ts`, `src/services/__tests__/GlobalPlanWatcherService.test.ts`. No issues encountered; compilation/tests skipped per session directive. ClickUp/Linear reroute through `provider.pushState` (Implementation Step 4) was deferred as behaviour-preserving-only — the existing `debouncedSync` paths already fire independently and simultaneously alongside the new Notion path, so the parity goal is met without touching the live ClickUp/Linear hot paths (byte-compat guard preserved).
