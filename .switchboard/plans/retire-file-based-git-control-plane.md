# Retire the file-based git control plane; hand board visibility to the read-only snapshot

**Plan ID:** fa04d992-5dc6-4cef-886a-525297581237

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
- **Tags:** refactor, backend
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
- **Call-site sweep (exact, verified 2026-07-06):** the manifest code footprint is small — delete
  `src/services/PlanManifestService.ts` outright, and in `src/services/GlobalPlanWatcherService.ts`
  remove the import (`:11`), the `private _manifestService = new PlanManifestService()` field
  (`:38`), and the manifest apply/scan path (`:824`, `_processManifest` at `:833-867`). No other
  code references it; build must stay green. (Agent-facing workflow-doc references are handled
  separately — see item 6 above.)
- **Missed cleanup sites (verified 2026-07-06):** beyond the manifest + GitStateProvider, the
  git-control-plane footprint spans:
  - `src/services/RemoteControlService.ts`: `RemoteProviderKind` type (`:39` — remove
    `'control-plane' | 'wiki'`), `GitStateProvider`/`GitProviderKind` import (`:4`), `_gitProviders`
    map (`:120`), `registerGitProvider` (`:175-177`), poll push block (`:326-339`),
    `_indexByRemoteId` git branch (`:391-397`), `_remoteIdOf` git branch (`:411-412`).
  - `src/services/KanbanProvider.ts`: `_buildRemoteProvider` (`:1718-1756` — remove `control-plane`/
    `wiki` branches at `:1729-1744`), git provider registration (`:1687-1707`).
  - `src/services/WorkspaceExcludeService.ts`: mirror carve-outs (`TARGETED_RULES :19-20`,
    `MIRROR_EXPORT_RULES :165-168`, conditional inclusion `:170-179`) — remove the
    `kanban-board.md`/`kanban-state-*.md` un-ignore lines so mirror files return to gitignored under
    `.switchboard/*`.
  - `src/services/PlanAutoFetchService.ts`: control-plane detection (`:128-140`, `:278-299`) and
    `MIRROR_FILE_RE` (`:327`) — the clean-tree guard's mirror-file ignorer becomes dead once the
    mirror is gone; remove the mirror-specific branches.
  - `src/services/SetupPanelProvider.ts` (`:313`, `:322`) + `src/webview/setup.html` (`:733-737`):
    the `boardStateExport` dropdown (none/control-plane/wiki) — remove the control-plane/wiki
    options, or replace with the read-only snapshot opt-in (see `board-state-read-snapshot.md`).
  - `src/services/TaskViewerProvider.ts` (`:4366-4367`, `:4395-4396`, `:4581-4583`): UI rendering of
    mirror files — remove.
  - `src/services/ControlPlaneMigrationService.ts` (`:578`, `:584`, `:1140`): migration logic
    referencing `boardStateExport === 'control-plane'` — this service is itself part of the
    control-plane legacy; assess whether it can be deleted outright or just its
    `boardStateExport`-conditioned branches.
  - `package.json` (`:537-553`): the `switchboard.boardStateExport` config schema — remove the
    `control-plane`/`wiki` enum values (or replace with the snapshot opt-in).

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

## Dependencies

- `board-state-read-snapshot.md` — takes over the *read-visibility* half of the retired mirror. Must
  land with/before this plan's mirror removal so remote read-visibility is never lost.
- `plan-authoring-frontmatter-facts.md` — takes over the *durable-fact* half (feature/project) of the
  retired manifest. Must land with this plan's manifest deletion so the feature/project role has a
  new home.
- No dependency on `delete-epic-file-resurrect-fix.md` — that is an independent correctness fix.

## Adversarial Synthesis

Key risks: (1) The call-site sweep is larger than the plan's original "small footprint" claim — 8
files beyond the manifest + GitStateProvider have git-control-plane references
(RemoteControlService, KanbanProvider, WorkspaceExcludeService, PlanAutoFetchService,
SetupPanelProvider, setup.html, TaskViewerProvider, ControlPlaneMigrationService, package.json). A
partial sweep leaves dead branches that reference deleted types → build breaks or silent no-ops.
Mitigation: the "Missed cleanup sites" list above is now exhaustive and line-verified; treat it as
the deletion checklist. (2) `ControlPlaneMigrationService` may itself be entirely dead once the
control plane is gone — assess deletion vs. branch-pruning; leaving it half-alive risks a future
agent re-introducing the pattern. (3) Workflow-doc updates (item 6) must ship in lockstep or remote
agents keep emitting `manifest.json` nothing reads. Mitigations: delete in dependency order
(GitStateProvider → RemoteControlService wiring → KanbanProvider `_buildRemoteProvider` → manifest →
config/UI → gitignore → workflow docs); build must stay green at each step.

## Proposed Changes

### `src/services/remote/GitStateProvider.ts` — delete outright (507 lines)

- **Context:** The entire file is the `**Column:**`-diff inbound channel + mirror push
  (`pushExportedState` at `:306-393`) + comment-diff polling (`fetchStateDeltas` `:58-154`,
  `fetchCommentDeltas` `:156-243`). All of it is the retired control plane.
- **Logic:** Delete the file. No code retains a reference after the RemoteControlService +
  KanbanProvider cleanup below.
- **Edge Cases:** The `postComment` method (`:261`) appends comments to plan files and commits —
  confirm no other code path depends on GitStateProvider comment behavior; if remote commenting is
  needed, it moves to Notion/Linear providers.

### `src/services/RemoteControlService.ts` — remove git provider wiring

- **Context:** `RemoteProviderKind` type (`:39`) includes `'control-plane' | 'wiki'`; `_gitProviders`
  map (`:120`), `registerGitProvider` (`:175-177`), poll push block (`:326-339`),
  `_indexByRemoteId` git branch (`:391-397`), `_remoteIdOf` git branch (`:411-412`).
- **Logic:** Remove `'control-plane' | 'wiki'` from `RemoteProviderKind`; remove the
  `GitStateProvider`/`GitProviderKind` import (`:4`); delete `_gitProviders`, `registerGitProvider`,
  the poll push block, and the git branches in `_indexByRemoteId` / `_remoteIdOf`. The remaining
  providers (linear, notion, clickup) are untouched.
- **Edge Cases:** The poll push block (`:326-339`) fires `pushExportedState` after processing
  inbound deltas — once removed, confirm Notion/Linear push paths are not affected (they use
  different push mechanisms).

### `src/services/KanbanProvider.ts` — remove git provider construction + registration

- **Context:** `_buildRemoteProvider` (`:1718-1756`) constructs `GitStateProvider` for
  `control-plane` (`:1729-1736`) and `wiki` (`:1738-1744`); registration at `:1687-1707`.
- **Logic:** Remove the `control-plane` and `wiki` branches from `_buildRemoteProvider`; remove the
  git provider registration calls at `:1687-1707`. The `notion`/`linear`/`clickup` branches stay.
- **Edge Cases:** `resolveEffectiveWorkspaceRoot` (used by the control-plane branch) may still be
  needed by other code — check before removing the import.

### `src/services/PlanManifestService.ts` — delete outright (351 lines)

- **Context:** Reads `manifest.json`, applies column/status/feature/project, deletes the file. All
  retired.
- **Logic:** Delete the file. In `GlobalPlanWatcherService.ts`: remove import (`:11`), field
  (`:38`), `_processManifest` method (`:833-867`), and the call site (`:824`).
- **Edge Cases:** The manifest's feature/project application moves to
  `plan-authoring-frontmatter-facts.md` (per-plan frontmatter on import); the column/status
  application moves to Notion/Linear providers + DB. Confirm no double-application if both ship
  together (the manifest is deleted, so its apply path is gone before the frontmatter path runs).

### `src/services/KanbanDatabase.ts` — retire `exportStateToFile` control channel

- **Context:** `exportStateToFile` (`:6474-6591`) + `_resolveExportRoot` (`:6599-6617`) write the
  mirror with a per-persist timestamp (`:6565`). The `control-plane|wiki` modes gate the export root.
- **Logic:** Remove the `control-plane`/`wiki` branches from `_resolveExportRoot`; the `none` default
  (no export) becomes the only non-provider mode. The snapshot publisher
  (`board-state-read-snapshot.md`) is a separate code path, not a mode of this function. Remove the
  `**Column:**` line emission (`:6550-6553`) — it was the control signal.
- **Edge Cases:** If `board-state-read-snapshot.md` reuses the serialization logic, extract the
  board-state-to-JSON/MD serialization into a shared helper before deleting the control-channel
  wrapper; do not force the snapshot plan to re-derive it.

### `src/services/WorkspaceExcludeService.ts` — remove mirror gitignore carve-outs

- **Context:** `TARGETED_RULES` (`:19-20`) un-ignores `kanban-board.md` / `kanban-state-*.md`;
  `MIRROR_EXPORT_RULES` (`:165-168`) + conditional inclusion (`:170-179`) toggle them on
  `boardStateExport !== 'none'`.
- **Logic:** Remove the mirror carve-out lines so mirror files return to gitignored under
  `.switchboard/*`. Remove `MIRROR_EXPORT_RULES`, `_boardStateExportEnabled`, and the conditional
  inclusion in `_effectiveTargetedRules`. The `plans/`/`features/`/`sessions/` un-ignore rules
  (`:11-17`) are untouched.
- **Edge Cases:** Existing repos with mirror files already committed — they become gitignored but
  remain tracked; a one-time `git rm --cached` is out of scope (unreleased feature, no install base).

### `src/services/PlanAutoFetchService.ts` — remove mirror-specific branches

- **Context:** Control-plane detection (`:128-140`, `:278-299`) and `MIRROR_FILE_RE` (`:327`) exist
  to tolerate dirty mirror files in the clean-tree guard (`:214-231`).
- **Logic:** Remove the control-plane detection branches and `MIRROR_FILE_RE`; the clean-tree guard
  no longer needs to ignore mirror files (they're gone). Keep the core default-branch-only fetch
  logic.
- **Edge Cases:** If any non-mirror file is also ignorable by the clean-tree guard today, confirm
  removing `MIRROR_FILE_RE` doesn't over-tighten the guard.

### Config / UI — remove `boardStateExport` control modes

- **Context:** `package.json` (`:537-553`) defines the enum; `SetupPanelProvider.ts` (`:313`,
  `:322`) + `setup.html` (`:733-737`) render the dropdown; `TaskViewerProvider.ts`
  (`:4366-4367`, `:4395-4396`, `:4581-4583`) renders mirror files.
- **Logic:** Remove `control-plane`/`wiki` from the enum (or replace with the snapshot opt-in per
  `board-state-read-snapshot.md`); remove the dropdown options; remove the TaskViewer mirror-file
  rendering.
- **Edge Cases:** Existing user configs with `boardStateExport: 'control-plane'` — the setting
  silently falls back to `none` (unreleased feature, acceptable).

### `src/services/ControlPlaneMigrationService.ts` — assess deletion vs. branch-pruning

- **Context:** References `boardStateExport === 'control-plane'` at `:578`, `:584`, `:1140`. This
  service is itself part of the control-plane legacy.
- **Logic:** Assess whether the entire service is dead once the control plane is gone. If yes,
  delete outright; if only the `boardStateExport`-conditioned branches are dead, prune those.
- **Edge Cases:** Other migration logic in the file may still be needed for the install base —
  read the full file before deleting.

### Workflow docs (`.agents/workflows/*.md`) — update in lockstep

- **Context:** `improve-plan.md` (Plan-Import Manifest section), `switchboard-chat.md` (Trigger B),
  `improve-feature.md` (2 spots), `switchboard-split.md`, `switchboard-index.md` (card-move +
  board-read rows) still tell remote agents to write `manifest.json`.
- **Logic:** Update to the go-forward mechanism: feature/project grouping → `**Feature:**`/
  `**Project:**` frontmatter; remote column moves → Notion/Linear provider or MCP; remote board
  reads → the read-only snapshot.
- **Edge Cases:** These ship to users — they must change with the code or remote agents keep
  emitting manifests nothing reads.

## Verification Plan

### Automated Tests

> Per session directive: automated tests skipped. Verification is manual code-review only.

### Manual Verification

1. **Build green:** After each deletion step (GitStateProvider → RemoteControlService →
   KanbanProvider → manifest → config/UI → gitignore → PlanAutoFetchService), confirm no dangling
   imports or type references remain (manual grep for `GitStateProvider`, `PlanManifestService`,
   `control-plane`, `wiki`, `manifest.json` in `src/`).
2. **No mirror files written:** With `boardStateExport` removed, trigger a DB persist (move a card)
   → confirm no `kanban-board.md` / `kanban-state-*.md` files are written to the working tree.
3. **Clean-tree guard holds:** With mirror files gone, run an auto-fetch cycle → confirm the
   clean-tree guard no longer needs `MIRROR_FILE_RE` and still passes on a clean tree.
4. **Notion/Linear control intact:** With GitStateProvider gone, confirm Notion/Linear providers
   still poll, push, and move cards (manual provider round-trip).
5. **Gitignore coherence:** Confirm `plans/`/`features/`/`sessions/` files are still un-ignored
   (committed plans land via auto-fetch); confirm mirror files are now gitignored.
6. **Workflow docs:** Grep `.agents/workflows/` for `manifest.json` → confirm zero references remain
   after the lockstep update.

## Recommendation

Complexity 6 → **Send to Coder**.
