# Remote Sync Refactor (3/3): Config Consolidation + Remote-Tab Ingest/Full UX

## Goal

Collapse the scattered sync config into **one per-board sync contract**, reconcile the two overlapping pull loops, and ship the **Remote-tab UX** the whole refactor was for: an **Ingest | Full** mode radio plus **comment polling** and **push** controls that the declared-capability matrix can honestly enable, disable, or gray out per provider. Because plans 1–2 made push real and provider-symmetric, **no toggle lies**.

### Core problem & background

The original request was a lightweight remote model — an *ingest-biased* mode where the remote is just a plan source and local Automation does the reacting, versus *full* remote control. The clean user-facing model is two modes (Ingest, Full) with two addons (push, comments). That model is correct but couldn't be shipped because push wasn't a Remote-tab concept (full analysis: `docs/remote_sync_architecture_refactor_analysis.md`). Plans 1–2 fix that. This plan delivers the UX on top.

The blocker this plan removes is **config fragmentation** — at least four surfaces touch sync with no single source of truth:

- `remote.config` (Remote tab) — provider, boards, silentSync, pingMode, ping frequency (pull).
- `realTimeSyncEnabled` (Setup, per Linear/ClickUp service) — whether push runs at all.
- `completeSyncEnabled` (Setup / Linear) — whether terminal-column status push runs.
- Auto-Pull modal (`kanban.html:3077`) — a **separate** background pull + interval, distinct from the Remote-tab ping loop.

A user reasoning about "is my board syncing, and which way?" must consult four places, two of which aren't even on the Remote tab.

### Root cause

Each capability was added in its own layer with its own config home, and the two pull mechanisms (Remote-tab ping vs. Auto-Pull modal) were never reconciled. The behavioral gates (mode = skip `_applyStateMirror`; comments = skip `_pollComments`) are individually trivial single-service changes in `RemoteControlService`; the real work is unifying config and not breaking ~4,000 existing installs.

## Metadata

- **Tags:** [backend, frontend, ui, refactor, reliability]
- **Complexity:** 8
- **Repo:** switchboard

## Scope (base level)

1. **One per-board sync contract**: `{ provider, mode: 'ingest' | 'full', push, comments, cadence }`. Migrate `remote.config`, `realTimeSyncEnabled`, `completeSyncEnabled`, and the Auto-Pull modal into (or behind) it.
2. **Behavioral gates in `RemoteControlService`**: in Ingest mode skip `_applyStateMirror` (state mirror + agent dispatch) while keeping state *import*; gate `_pollComments` on the comments toggle. Both are clean single-service changes.
3. **Reconcile the two pull loops** — fold the Auto-Pull modal's background pull and the Remote-tab ping loop into one.
4. **Remote-tab UX**: Ingest | Full radio, comment-polling toggle, and a push control whose availability is driven by the provider's declared `capabilities` (e.g. Full mode disabled for a push-only/pull-only provider). Default to **Ingest**.
5. **Migration (≈4,000 installs)**: import-before-delete; preserve existing `realTimeSyncEnabled` / `completeSyncEnabled` behavior for users who set them in older versions; archive legacy keys rather than dropping them (CLAUDE.md migration rules).

## Decisions (already settled — do not re-litigate)

- **Refactor-first, no stopgap.** Do not ship the ingest/full toggle before plans 1–2 land; a premature toggle would present a push story that's a dead end for Notion.
- **Default mode is Ingest.**
- **ClickUp stays push-only** — it never appears as a Remote-tab control provider; the capability matrix grays it out of Full/pull honestly.
- **No confirmation dialogs** anywhere in the new UI (house rule; `confirm()` is also a silent no-op in webviews).

## Dependencies

- **Plan 1** (provider capabilities + unified push) and **Plan 2** (Notion push) — both required. The push control and per-provider mode gating are only honest once push is real and symmetric across providers.

## Source

Derived from `docs/remote_sync_architecture_refactor_analysis.md` (Sequencing → Plan 3; open questions #3, #5). Base-level plan — run `/improve-plan` to deepen before execution.
