# Retire the file-based git control plane; hand board visibility to the read-only snapshot

## Goal

Delete the file-based git control-plane machinery outright — the board-state mirror export used as
a control channel, the `GitStateProvider` `**Column:**`-diff channel, the
`boardStateExport: control-plane|wiki` diff/control modes, and `manifest.json` /
`PlanManifestService` entirely. Remote *control* stays with the existing non-branching API
providers (Notion, Linear). Board *read-visibility* moves to a one-directional, read-only snapshot
on an orphan branch (see `board-state-read-snapshot.md`). Keep the parts that genuinely work: plans
committed as files, and auto-fetch to land them.

**This is an unreleased/experimental feature — clean break, no migration, no compat shims** (per
CLAUDE.md: unreleased dev work takes clean breaks). Nothing in the install base emits or consumes
these files, so there is no reader to keep and no data to preserve.

### Core problem & root cause

The file-based control plane tries to carry **live, mutable, shared** board state through git,
which git's branching model fundamentally can't hold:
- **Permanently dirty tree:** `exportStateToFile` rewrites the mirror on every `_persist` (its
  timestamp line changes constantly), which repeatedly broke `PlanAutoFetchService`'s clean-tree
  guard (patched piecemeal, e.g. `faf4d82`).
- **Un-mergeable across branches:** the mirror and `manifest.json` are single fixed-path mutable
  files; concurrent branches writing them merge-conflict or corrupt (this repo merged conflicting
  PRs #26/#27 during the original investigation).
- **State resurrection:** consume-then-delete is a local op that never reaps through git, so a
  merged manifest (e.g. #31's) resurrects on every fresh clone.

These are not fixable in place — they're properties of using git files for mutable control state.
The resolution (settled with the user): **control stays on non-branching API providers** (Notion,
Linear); git carries only durable authored artifacts (plan files) plus a one-directional read-only
board snapshot (`board-state-read-snapshot.md`) that never merges into the code branches.

## Metadata

- **Project:** Switchboard
- **Tags:** remote-control, cleanup, deprecation, git
- **Complexity:** 6

## What gets removed / handed off

1. **Delete the git-native control option.** Remove the `control-plane`/`wiki` control providers
   built in `KanbanProvider._buildRemoteProvider` and the `boardStateExport: control-plane|wiki`
   *control* modes. There is no git-native *control* replacement — remote control is Notion/Linear.
   (A GitHub Issues provider was considered as a git-hosted control channel and dropped: issue
   fields are org-scoped, unusable on personal-account repos — see the feature history.)
2. **Delete `GitStateProvider`** (`src/services/remote/GitStateProvider.ts`) and its wiring in
   `RemoteControlService` (`_buildRemoteProvider`, poll integration). This deletes the
   `**Column:**`-diff inbound channel and the mirror push.
3. **Remove the mirror export as a *control* channel — hand read-visibility to the snapshot.**
   `KanbanDatabase.exportStateToFile` + `_resolveExportRoot` and the `control-plane|wiki` modes stop
   being a bidirectional control channel. Board read-visibility is served by
   `board-state-read-snapshot.md` — a one-directional, always-overwrite, read-only snapshot
   (`board.json` + `board.md`) on the orphan branch `switchboard/board`, default off. `none` becomes
   the only non-provider *control* mode.
4. **Delete `manifest.json` / `PlanManifestService` entirely.** Remove the service, its call sites,
   and any manifest read/write. Remote *authoring* of plans stays (commit `.md` files →
   `GlobalPlanWatcher` import → auto-fetch). The manifest's DB-owned fields move: column/status →
   provider or DB; feature/project → durable per-plan frontmatter facts
   (`plan-authoring-frontmatter-facts.md`). Because the feature is unreleased, this is a straight
   deletion, not a deprecation.
5. **Keep:** `PlanAutoFetchService` (lands committed plans) and the `WorkspaceExcludeService`
   gitignore rules for `plans/`, `features/`, `sessions/`.
6. **Update the agent-facing workflow docs in lockstep.** Several workflow definitions still tell
   *remote* agents to write `.switchboard/plans/manifest.json`: `improve-plan.md` (Plan-Import
   Manifest section), `switchboard-chat.md` (Trigger B section), `improve-feature.md` (2 spots),
   `switchboard-split.md`, and `switchboard-index.md` (card-move + board-read rows). When the code
   lands, update these to the go-forward mechanism — feature/project grouping →
   `**Feature:**`/`**Project:**` frontmatter facts (`plan-authoring-frontmatter-facts.md`); remote
   column moves → Notion/Linear provider or MCP; remote board reads → the read-only snapshot
   (`board-state-read-snapshot.md`). They ship to users, so they must change with the code — or
   remote agents keep emitting manifests nothing reads.

## User Review Required

- **None.** Unreleased/experimental feature → clean removal, no migration decision to make.

## Complexity Audit

### Routine
- Deleting `GitStateProvider`, `PlanManifestService`, and the `boardStateExport` control modes.
- Removing the git-native control option from config/UI (no replacement — control is Notion/Linear).

### Complex / Risky
- **Sequencing:** land `board-state-read-snapshot.md` with/before removing the mirror so remote
  read-visibility is never lost. There is no *control* gap — Notion/Linear already serve control.
- **Gitignore coherence:** removing the mirror carve-outs must not disturb the `plans/`/`features/`/
  `sessions/` un-ignore rules (`WorkspaceExcludeService`). The mirror files return to being
  gitignored under `.switchboard/*` (the snapshot writes to its own orphan ref, not the code tree).
- **Call-site sweep (exact, verified 2026-07-04):** the manifest code footprint is small — delete
  `src/services/PlanManifestService.ts` outright, and in `src/services/GlobalPlanWatcherService.ts`
  remove the import (`:10`), the `private _manifestService = new PlanManifestService()` field
  (`:37`), and the manifest apply/scan path (`~:824`). No other code references it; build must stay
  green. (Agent-facing workflow-doc references are handled separately — see item 6 above.)

## Edge-Case & Dependency Audit

- **Depends on / pairs with:** `board-state-read-snapshot.md` (takes over read-visibility) and
  `plan-authoring-frontmatter-facts.md` (where feature/project go). No dependency on any new control
  provider — control is the existing Notion/Linear.
- **Notion/Linear untouched** — they remain the control providers.
- **Deletes the `**Column:**` namespace collision** we found — with `GitStateProvider` gone,
  nothing else parses `**Column:**` from diffs, so no plan-frontmatter column key is needed at all.
- **Migration: none.** The file-based control plane and `manifest.json` are unreleased/experimental
  — clean break, no migration, no archived `.migrated.bak`, no preserved keys. Plan *authoring* via
  committed `.md` files (a shipped, working path) is untouched.
