# Retire the file-based git control plane; repoint the git remote option to Issues

## Goal

Remove the file-based git control-plane mechanisms — the board-state mirror export, the
`GitStateProvider` `**Column:**`-diff channel, the `boardStateExport: control-plane|wiki` modes,
and `manifest.json` as a control channel — and repoint the "github/git" remote-control option to
the new `GitHubIssuesRemoteProvider`. Keep the parts that genuinely work: plans committed as
files, and auto-fetch to land them.

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
The resolution (settled with the user): **control moves to non-branching API providers** (Notion,
Linear, and now GitHub Issues); git carries only durable authored artifacts (plan files).

## Metadata

- **Project:** Switchboard
- **Tags:** remote-control, github, cleanup, deprecation, git
- **Complexity:** 6

## What gets removed / repointed

1. **Repoint the git remote option to Issues.** Wherever the remote-control config offers a
   git-native destination (`boardStateExport: control-plane|wiki`, the `control-plane`/`wiki`
   providers built in `KanbanProvider._buildRemoteProvider`), replace it with the
   `github-issues` provider (`github-issues-remote-provider.md`). The "control via git" option in
   config/UI becomes "control via GitHub Issues".
2. **Remove `GitStateProvider`** (`src/services/remote/GitStateProvider.ts`) and its wiring in
   `RemoteControlService` (`_buildRemoteProvider`, poll integration). This deletes the
   `**Column:**`-diff inbound channel and the mirror push.
3. **Remove the mirror export as a control channel.** `KanbanDatabase.exportStateToFile` +
   `_resolveExportRoot` and the `boardStateExport: control-plane|wiki` modes. If a human-readable
   board snapshot is still wanted, replace it with an explicitly **read-only, opt-in** export
   (no push loop, no diff-ingest) — but default off. `none` becomes the only non-provider mode.
4. **Retire `manifest.json` as a control channel.** Remote *authoring* of plans stays
   (commit `.md` files → `GlobalPlanWatcher` import → auto-fetch). The manifest's DB-owned fields
   move: column/status → provider or DB; epic/project → durable per-plan frontmatter facts
   (`plan-authoring-frontmatter-facts.md`). Keep `PlanManifestService` reading for one release
   only if any shipped path emits manifests (audit says the control-plane export is unshipped, so
   a clean cut is likely fine — verify no released VSIX ships `boardStateExport != none`).
5. **Keep:** `PlanAutoFetchService` (lands committed plans; the activity-light + provider work
   depends on nothing here) and the `WorkspaceExcludeService` gitignore rules for `plans/`,
   `epics/`, `sessions/`.

## User Review Required

- Confirm the file-based control plane is genuinely unshipped (no released VSIX defaults
  `boardStateExport` to `control-plane`/`wiki`) → clean removal, no migration. **If any released
  build shipped it on, downgrade to a deprecation path instead of deletion.**
- Confirm whether to keep a read-only board snapshot export at all, or drop mirrors entirely.
- Confirm the manifest reader can be removed outright vs kept one release.

## Complexity Audit

### Routine
- Deleting `GitStateProvider` and the mirror-export/`boardStateExport` control modes.
- Repointing the config/UI git option to the `github-issues` provider.

### Complex / Risky
- **Sequencing:** ship *after/with* `github-issues-remote-provider.md` so there is never a gap
  with zero git-native control. Do not remove the file plane before the Issues provider lands.
- **Gitignore coherence:** removing the mirror carve-outs must not disturb the `plans/`/`epics/`/
  `sessions/` un-ignore rules (`WorkspaceExcludeService`). The mirror files return to being
  gitignored under `.switchboard/*`.
- **Shipped-surface check:** the manifest ingest path *is* shipped; only the mirror/control-plane
  export is unshipped. Retire the manifest's *control* role carefully, preserving remote plan
  *authoring* via files.

## Edge-Case & Dependency Audit

- **Depends on:** `github-issues-remote-provider.md` (the replacement) and
  `plan-authoring-frontmatter-facts.md` (where epic/project go). 
- **Notion/Linear untouched** — they remain the other two API providers.
- **Deletes the `**Column:**` namespace collision** we found — with `GitStateProvider` gone,
  nothing else parses `**Column:**` from diffs, so no plan-frontmatter column key is needed at all.
- **Migration:** per CLAUDE.md, confirm shipped-vs-unshipped before deleting; unshipped → clean
  break, shipped → deprecate. The mirror/control-plane is unshipped; the manifest ingest is
  shipped (handle its control role, not its plan-authoring role).
