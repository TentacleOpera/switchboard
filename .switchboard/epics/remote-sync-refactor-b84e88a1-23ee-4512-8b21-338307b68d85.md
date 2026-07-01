---
description: 'Remote Sync Refactor'
---

# Remote Sync Refactor

**Plan ID:** b84e88a1-23ee-4512-8b21-338307b68d85

> **Program note (2026-07-01):** This is the **trunk** of the remote-control production program (see `feature_plan_20260701_remote-control-production-sequencing.md`). Two additions vs. the original scope: (1) the declared push surface must include **`archive`** (for the auto-archive rule) and a **project-level entity** (for project-context sync) — declared in 1/3, not retrofitted; the full surface is **status · content · archive · project-context docs** (epic *structure* mirroring is handled by the Remote Epic Structure epic; outbound structure by the Tracker-Structure feature). (2) 3/3's Remote-tab UX is built in the tab's new home in **`project.html`** — so the Project Context Hub epic's STEP 0 (IA lock) precedes 3/3's UI phase. **Linear bidirectional description sync** is folded in here as a content-push capability on the unified seam.

## Goal

Reconcile Switchboard's remote/sync system so that **push is a first-class, provider-symmetric capability** alongside pull, and ship the lightweight **Ingest vs. Full** remote modes the system was missing. Today the remote feature implies a heavy "active polling + agent write-back" model, when most users want a lighter pattern — the remote as a plan *source*, with local Automation doing the reacting.

### Core problem & background

The remote/sync system grew in layers that were never reconciled (full analysis: `docs/remote_sync_architecture_refactor_analysis.md`). There are **three sync behaviors across two subsystems with two different provider abstractions**, and the provider sets don't line up:

- **Pull/ingest** (`RemoteControlService` + the `RemoteProvider` interface) is clean and provider-agnostic — Linear + Notion.
- **Push** (status via column-move handlers; content via `ContinuousSyncService`) is **not abstracted at all** — it reaches for concrete services, is gated by a different flag (`realTimeSyncEnabled`) set in Setup, and targets **Linear + ClickUp only**.

The consequence is a deliberately-ragged-but-undeclared capability matrix: **Linear** is bidirectional, **ClickUp** is push-only (a stakeholder-visibility surface, correct by design), and **Notion** is pull-only — meaning Notion can *drive* the board but can never be *written back to*, so the agent-driven code-automation loop silently half-works. On top of that, sync config is fragmented across four surfaces with no single source of truth.

### Root cause

Remote control (pull) was bolted onto a legacy push-from-local sync system; the legacy automation was later split into bug-triage vs. remote-control, but **the push half was never folded into the provider abstraction**. A provider's capabilities ended up *implicit and scattered* instead of *declared*.

### Approach (settled: refactor-first)

Fix the foundation before shipping the UX. Make push a declared provider capability behind the existing abstraction, build the missing Notion push, then consolidate config and ship the Ingest/Full UX on top — so no UI toggle ever lies about what a provider can do. **Symmetry is not the goal**; declared capabilities are — ClickUp stays push-only, and the only real provider gap to close is Notion push.

## How the Subtasks Achieve This

- **Remote Sync Refactor (1/3): Declared Provider Capabilities + Unified Push Dispatch**: Adds `capabilities: { pull, push }` and `pushState` / `pushContent` to the `RemoteProvider` interface, introduces a single provider registry shared by both pull and push, and reroutes the existing Linear/ClickUp push triggers through it. Behavior-preserving — the foundation everything else plugs into.

- **Remote Sync Refactor (2/3): Notion Push Pipeline**: Implements `pushState` / `pushContent` for Notion (wiring the already-existing `updatePageContent` plus a new status-property write), flips Notion's declared capability to `push: true`, and re-proves the echo-loop guards for Notion's new round trip. Closes the one real provider gap.

- **Remote Sync Refactor (3/3): Config Consolidation + Remote-Tab Ingest/Full UX**: Collapses the four sync-config surfaces into one per-board contract, reconciles the two overlapping pull loops, and ships the Ingest | Full mode radio plus comment-polling and push controls — gated honestly by each provider's declared capabilities. The original ask, delivered on a foundation where push is real and symmetric. Carries the ~4,000-install migration.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Remote Sync Refactor (1/3): Declared Provider Capabilities + Unified Push Dispatch](../plans/remote-sync-refactor-1-provider-capabilities-and-unified-push.md) — **PLAN REVIEWED**
- [ ] [Remote Sync Refactor (2/3): Notion Push Pipeline (Status + Content Write-Back)](../plans/remote-sync-refactor-2-notion-push-pipeline.md) — **PLAN REVIEWED**
- [ ] [Remote Sync Refactor (3/3): Config Consolidation + Remote-Tab Ingest/Full UX](../plans/remote-sync-refactor-3-config-consolidation-and-remote-tab-ux.md) — **PLAN REVIEWED**
- [ ] [Linear Bidirectional Description Sync](../plans/linear-bidirectional-description-sync.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Metadata

**Tags:** [backend, frontend, ui, api, refactor, reliability, feature]
**Complexity:** 8
**Repo:** switchboard

**Subtask complexity rollup:**
| Subtask | Complexity |
|---------|-----------|
| 1/3 — Declared Provider Capabilities + Unified Push Dispatch | 6 |
| 2/3 — Notion Push Pipeline | 6 |
| 3/3 — Config Consolidation + Remote-Tab Ingest/Full UX | 8 |

The epic-level complexity (8) matches the hardest subtask but is driven as much by **strict sequencing** as by any single plan: the three plans are a hard dependency chain (2 requires 1; 3 requires 1 + 2), the echo-loop guards must stay correct as push gains state-write across providers, and plan 3 carries a four-surface config consolidation with a ~4,000-install migration that must preserve legacy `realTimeSyncEnabled` / `completeSyncEnabled` behavior.

## Decisions (settled — do not re-litigate)

- **Refactor-first, no stopgap.** Do not ship the Ingest/Full toggle before plans 1–2 land.
- **ClickUp stays push-only.** It never becomes a Remote-tab control provider; the matrix is intentionally ragged and declared, not forced symmetric.
- **Notion push is the one real gap** the refactor must build.
- **Default remote mode is Ingest.**
- **No confirmation dialogs** in any new UI (house rule; `confirm()` is a silent no-op in webviews).

## Source

`docs/remote_sync_architecture_refactor_analysis.md` — full discovery, current-architecture map (with file:line evidence), capability matrix, decision record, and sequencing.
