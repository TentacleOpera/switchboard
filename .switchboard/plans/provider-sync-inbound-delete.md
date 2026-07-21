---
description: "Inbound-delete parity: when a plan card is deleted/archived in ClickUp/Linear/Notion, tombstone the mapped local plan. Net-new deletion detection — the RemoteStateDelta seam has NO deletion signal today, so a removed remote item vanishes silently. Reconcile-sweep mechanism, driven off the existing host-agnostic poll loop, opt-in and default-off, recoverable tombstone (never hard-delete), never touches unmapped plans. The higher-risk half, split from provider-sync-full-parity; sibling of provider-sync-outbound-parity."
---

# Provider Sync — Inbound Delete (ClickUp / Linear / Notion)

## Goal

Close the last two-way-sync gap: a plan card **deleted or archived in the tracker** (ClickUp/Linear/Notion) should mark the mapped local plan as deleted (recoverable tombstone), for all three providers — without ever touching unmapped local plans or hard-deleting local work.

### Core problem / root cause (verified against merged source, 2026-07-21)

There is **no inbound-delete at the kanban-plan seam today** — and this is net-new work, not a "confirm/extend." Verified:

- `RemoteStateDelta` ([RemoteProvider.ts:19-42](../../src/services/remote/RemoteProvider.ts#L19)) carries `stateKey`, `parentRemoteId`, `updatedAt`, `description`, `selfEdited` — **no deletion field**.
- `fetchStateDeltas` reports state *changes*; a removed/archived remote item produces **no delta** — it simply stops appearing in the query result, so the poll ([RemoteControlService.ts:400-438](../../src/services/RemoteControlService.ts#L400)) never sees it go.
- The `respect-remote-deletions`/tombstone logic that does exist lives in `TaskViewerProvider`/`GlobalPlanWatcherService` for the **tickets tab** and for **local** file-deletion tombstones — a different code path from the RemoteControlService kanban-plan poll.

So detection must be built. Because Notion exposes no "deleted since timestamp" query (confirmed by research), a delta-field approach can't cover all three uniformly — the mechanism is a **reconcile-sweep**.

## Metadata
- **Tags:** backend, integrations, reliability, refactor
- **Complexity:** 7
- **Project:** Browser Switchboard
- **Release phase:** Builds on the merged Remote Sync Refactor seam + `provider-sync-outbound-parity`. Destructive (local tombstone) → strictly opt-in, default off, so the ~4,000 existing installs are unchanged until enabled.

## User Review Required
- **None — mechanism and cadence are settled** (see Decisions 1–2). The sweep runs off the existing `RemoteControlService` poll: once on `start()` **and** every Nth poll cycle. `start()`-only was rejected — a headless service boots once and runs for days, so it would miss every mid-run deletion. The only free parameter is **N** (polls between sweeps), a tuning default, not a design decision: default to a sweep roughly every 10–15 minutes of wall-clock (i.e. N = `round(600–900s / pollFrequencySeconds)`), bounded so a ~13s sweep never starves the normal poll. Tunable later without a redesign.

## Decisions (settled — do not re-litigate)
1. **Reconcile-sweep, not delta-field.** Paginate the live remote id set per provider and diff against locally-mapped `remoteId`s; a mapped id absent from the live set is a candidate deletion. (Notion has no deletion delta, so delta-field can't cover all three — see Root cause.)
2. **Cadence hangs off the existing poll loop — host-agnostic, NOT a VS Code "workspace-open" event.** `RemoteControlService` is plain Node `setInterval` ([:299](../../src/services/RemoteControlService.ts#L299)) with a one-time catch-up reconcile already on `start()` ([:264-283](../../src/services/RemoteControlService.ts#L264)). The sweep = one on `start()` (reuse that hook) + optionally one every Nth poll cycle. This behaves identically in the extension and in headless (both drive the same `start()` + poll); "workspace-open" would only fire once at headless boot.
3. **Opt-in, recoverable tombstone — never hard-delete.** Default off. On a detected deletion, tombstone via `KanbanDatabase.tombstonePlan` ([:5534](../../src/services/KanbanDatabase.ts#L5534)) — reuse the existing tombstone machinery; never `git rm`; never touch unmapped local plans.

## Scope

### ✅ IN SCOPE
- **Reconcile-sweep deletion detection** for kanban plans across all three providers, per Decisions 1–2.
- **Opt-in tombstone** of the mapped local plan on detected deletion, per Decision 3.
- **Rate-limit safety:** throttle to ≤ ~2.5 RPS and honour `Retry-After`; only act on a **complete** sweep (a partial sweep aborted by backoff must not produce false "missing").
- **Move-vs-delete disambiguation:** distinguish a card that merely moved out of the queried database/list/scope from one genuinely deleted, before tombstoning.

### ⚙️ OUT OF SCOPE
- **Outbound parity** (gate removal, Notion create/archive, seam routing) → sibling plan `provider-sync-outbound-parity`.
- Webhook-based deletion (would need a public endpoint; reconcile-sweep is the chosen mechanism). Note it as a future optimisation only.
- Hard-delete of local work under any circumstance.

## Implementation Steps
1. **Add a reconcile-sweep** per provider: paginate the live remote id set, diff against locally-mapped `remoteId`s. Throttle ≤ ~2.5 RPS, honour `Retry-After`, and only produce a deletion list from a fully-completed sweep.
2. **Wire cadence** off `RemoteControlService`: run the sweep on `start()` (reuse the catch-up hook) and, per User Review #1, optionally every Nth `_poll` cycle. No VS Code lifecycle dependency.
3. **Tombstone on detection:** for each mapped id absent from the live set, tombstone the local plan via `KanbanDatabase.tombstonePlan`, gated by the opt-in flag (default off), never touching unmapped plans.
4. **Disambiguate move-vs-delete** before tombstoning (e.g. re-check the id directly / confirm genuine absence vs scope change).
5. **Loop safety:** the sweep must not tombstone a plan whose outbound create is mid-round-trip (coordinate with the outbound id-persist ordering from the sibling plan).

## Complexity Audit
### Routine
- Reusing `KanbanDatabase.tombstonePlan` for the local side.
- Hanging a new call off the existing `start()` + poll loop.

### Complex / Risky
- **Net-new and destructive.** No deletion signal exists; the mechanism is built from scratch and can tombstone live plans if it misfires. Highest risk.
- **False-missing from partial sweeps / rate-limit backoff.** A sweep aborted mid-pagination (429/529) must not report the un-fetched tail as "deleted." Only act on a complete sweep.
- **Move-vs-delete ambiguity.** A card moved out of the queried scope looks identical to a deletion in a scoped query — must disambiguate or it tombstones live plans.
- **Race with outbound create.** A plan whose Notion page is mid-creation (id not yet persisted) must not be seen as "mapped id missing" and tombstoned.
- **Cost/rate budget.** A full sweep consumes the ~3 RPS quota for ~13s at 4,000 cards — must not starve the normal poll.

## Edge-Case & Dependency Audit
- **Race Conditions:** sweep vs in-flight outbound create (mid-round-trip id); sweep interrupted by `Retry-After` backoff (partial set).
- **Security:** deletion is destructive to local state → opt-in default-off is the guard; a compromised/misconfigured remote must not trigger local data loss by default. No new secrets; reuses authed provider HTTP.
- **Side Effects:** tombstones local plans (recoverable, never `git rm`); consumes provider rate budget during a sweep.
- **Dependencies & Conflicts:** depends on the outbound id round-trip (sibling plan) being atomic so a mid-create plan isn't mis-flagged; reuses `KanbanDatabase.tombstonePlan` and the `deleteSyncEnabled`-style opt-in pattern.

## Dependencies
- No session dependencies (`sess_…`) — builds on already-merged code in `main`.
- **Sibling:** `provider-sync-outbound-parity`. Soft ordering: ship outbound first — the sweep's mid-create race-guard assumes the outbound id-persist ordering exists.
- **Reuses:** `KanbanDatabase.tombstonePlan` ([:5534](../../src/services/KanbanDatabase.ts#L5534)), the `RemoteControlService` poll loop (`start()` + `setInterval`), the provider list/query surfaces.

## Adversarial Synthesis

**Risk Summary:** This is the landmine the parent plan mislabeled as "confirm/extend." Key risks: (1) it is net-new destructive deletion detection with no seam signal, so a misfire tombstones live plans; (2) rate-limit backoff mid-sweep can produce a false "missing" tail; (3) a card moved out of scope looks identical to a deletion in a scoped query; (4) a mid-create plan (outbound id not yet persisted) can be mis-flagged. Mitigations: opt-in default-off + recoverable tombstone (never hard-delete, never unmapped); act only on a fully-completed sweep; explicit move-vs-delete disambiguation; coordinate with the sibling plan's atomic id-persist ordering; cadence off the existing host-agnostic poll so it works in headless without starving normal sync.

## Resolved Assumptions

Web research (2026-07-21), verified against merged code. **The extension pins `Notion-Version: 2022-06-28`** ([NotionFetchService.ts:145](../../src/services/NotionFetchService.ts#L145)).

1. **Deletion detection = reconcile-sweep.** No "deleted/archived since timestamp" delta query exists; a standard database query excludes archived/deleted pages, so a removed mapped page simply stops appearing → paginate the live id set and diff against locally-mapped ids. Confirms reconcile-sweep as the only cross-provider-uniform mechanism.
2. **Rate limits.** ~3 RPS per integration, `429`/`529` with a `Retry-After` header; a ~4,000-card sweep ≈ 40 sequential queries ≈ ~13s. Throttle ≤ ~2.5 RPS, honour `Retry-After`, run off the poll (not per-cycle).

### Non-blocking caveat (out of scope)
Notion `2025-09-03`/`2026-03-11` API versions change parenting/trash semantics — irrelevant while pinned to `2022-06-28`; a future pin bump is a separate migration.

## Proposed Changes

### src/services/remote/RemoteProvider.ts + per-provider query surfaces
- **Context:** no deletion signal on `RemoteStateDelta`; each provider can list its live items (Notion database query, Linear issues, ClickUp tasks).
- **Logic:** add a provider method to enumerate the live remote id set (paginated), used by the sweep. No change to `RemoteStateDelta` required (reconcile-sweep is out-of-band from the delta poll).
- **Edge Cases:** pagination completeness; `Retry-After` backoff must not truncate the set silently.

### src/services/RemoteControlService.ts
- **Context:** poll loop (`start()` :257-283, `setInterval` :299, `_poll` :304).
- **Logic:** invoke the reconcile-sweep on `start()` (reuse the catch-up hook) and, per User Review #1, every Nth `_poll` cycle; feed the deletion candidate list to the tombstone step.
- **Implementation:** throttle; only act on a complete sweep; skip ids that are mid-create.
- **Edge Cases:** partial sweep on backoff; sweep overlapping a normal poll (guard like `_polling`).

### src/services/KanbanDatabase.ts (reuse) + tombstone wiring
- **Context:** `tombstonePlan` ([:5534](../../src/services/KanbanDatabase.ts#L5534)) already exists.
- **Logic:** on a confirmed deletion (opt-in on), call `tombstonePlan` for the mapped local plan only; never unmapped; never `git rm`.
- **Edge Cases:** already-tombstoned (idempotent); opt-in off → detection may run but takes no destructive action (or is skipped entirely).

## Verification Plan

> Compilation and automated-test runs were skipped during planning per session directive; the below is the intended verification for the implementer.

### Automated Tests
- With each provider configured + inbound-delete opt-in on: deleting/archiving a mapped tracker item tombstones (recoverably) only the mapped local plan, for all three providers.
- Never touches an unmapped local plan; opt-in off → no destructive action.
- Partial sweep (simulated 429 mid-pagination) produces **no** false tombstone.
- A card moved out of scope (not deleted) is **not** tombstoned.
- A plan mid-outbound-create (id not yet persisted) is **not** tombstoned.

### Manual
- Delete a page in Notion (and a task in ClickUp, an issue in Linear) with inbound-delete on → the mapped local plan tombstones. Delete an unmapped remote item → nothing local is touched. Confirm the sweep runs in headless (service `start()`), not just in the VS Code extension.

## Recommendation

**Send to Lead Coder** (Complexity 7). Ship after `provider-sync-outbound-parity`; keep behind its own opt-in flag, default off.

**Stage Complete:** CREATED

## Completion Summary

Implemented inbound-delete reconcile-sweep for ClickUp/Linear/Notion. Added `reconcileLiveIds` (paginate live remote id set, throttled, honour Retry-After, report `complete=false` on partial sweep) and `probeRemoteId` (move-vs-delete disambiguation) to the `RemoteProvider` interface and all three provider implementations. Wired cadence into `RemoteControlService`: sweep runs on `start()`, `reconcileOnce()`, and every Nth `_poll` cycle (N sized to ~10 min wall-clock, bounded [4,20]). Tombstone on detection reuses `KanbanDatabase.tombstonePlan` (recoverable, never hard-delete, never `git rm`, never unmapped). Opt-in is per-provider via `inboundDeleteEnabled` flags on `NotionRemoteSetup` and ClickUp/Linear configs (all default false); a new `getInboundDeleteEnabled` dep on `RemoteControlService` resolves them, and the sweep is skipped entirely when the flag is off. Mid-create race guard: `registerOutboundCreate` on `RemoteControlService` records freshly-persisted remote ids for a 60s window; the sweep skips any mapped id in that window so a plan whose Notion page is mid-creation isn't mis-flagged. Files changed: `src/services/remote/RemoteProvider.ts`, `src/services/remote/NotionRemoteProvider.ts`, `src/services/remote/LinearRemoteProvider.ts`, `src/services/remote/ClickUpRemoteProvider.ts`, `src/services/remote/notionRemoteConfig.ts`, `src/services/RemoteControlService.ts`, `src/services/KanbanProvider.ts`, `src/services/ClickUpSyncService.ts`, `src/services/LinearSyncService.ts`. No issues encountered; compilation/tests skipped per session directive.
