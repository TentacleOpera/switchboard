# Board-state read snapshot (isolated ref, one-directional)

## Goal

Give a remote git-connected agent read-visibility of the board — what cards exist and which
column each is in — without the dirty-tree / merge-conflict / resurrection failures of the
retired bidirectional file mirror.

### Core problem & root cause

The old mirror (`kanban-board.md` / `kanban-state-*.md`) was written into the code branches'
working tree, rewritten on every DB persist (changing timestamp), and doubled as a bidirectional
control channel (`GitStateProvider` diffing `**Column:**` lines). That produced a permanently
dirty tree (breaking `PlanAutoFetchService`'s clean-tree guard), cross-branch merge conflicts on a
single fixed-path mutable file, and state resurrection. `de3f563` untracked the mirrors (default
`boardStateExport: none`), which removed the problems but also removed remote read-visibility.
Root cause: a frequently-changing, bidirectional file living on the code branches. Strip both
properties and read-visibility is safe.

## Metadata

- **Project:** Switchboard
- **Tags:** remote, board-state, export, git, visibility
- **Complexity:** 5

## Design — one-directional snapshot on an orphan branch

- **Location:** an orphan branch `switchboard/board` in the same repo (chosen over the wiki:
  same-repo auth + discoverability, works on personal *and* org repos, trivially fetchable by a
  remote agent, never merges to `main` so no dirty tree / conflicts).
- **One-directional, always-overwrite:** the extension is the sole writer; each publish overwrites
  the snapshot to current DB state. No diff-ingest, no control, no consume-then-delete → nothing to
  conflict on, nothing to resurrect. If the DB drops a card, the next snapshot omits it.
- **Content-stable:** no per-persist timestamp; regenerate only when board state actually changes,
  debounced. (The timestamp-on-every-persist churn is exactly what to avoid.)
- **Artifacts:** `board.json` (machine-readable: `plan_id → {topic, column, order, feature, project}`)
  + `board.md` (human table). Keep it small — plans already carry content + project/feature
  frontmatter, so the snapshot's unique job is *current column + layout*.
- **Publish:** commit to the orphan ref and push; single-flight; exclude the ref from CI triggers /
  branch protection. Lift the git commit+push plumbing from the retired
  `GitStateProvider.pushExportedState` into a small read-only snapshot publisher.
- **Setting:** repurpose `boardStateExport`'s non-`none` modes into this read-only snapshot;
  default stays opt-in (off).

## User Review Required

- Confirm orphan branch name `switchboard/board`.
- Confirm default stays opt-in (off), matching today's `none` default.
- Confirm `board.json` shape and whether to include archived/completed cards.

## Complexity Audit

### Routine
- Serializing DB board state to `board.json` / `board.md`.
- Commit + push to a dedicated ref (lifted from the retired pusher).

### Complex / Risky
- **Orphan-branch lifecycle:** create-once then update; handle first publish (branch absent) and
  overwrite/force-push semantics; keep it out of CI / branch protection.
- **Debounce + content-stability:** must not republish on no-op persists.
- **Multi-writer:** two machines publishing → last-write-wins is correct (it's a snapshot; the DB
  is authority); avoid interleaved partial pushes (single-flight).

## Edge-Case & Dependency Audit

- **Depends on:** `retire-file-based-git-control-plane.md` (which removes the bidirectional mirror
  + `GitStateProvider`; this replaces the *read* half only).
- **Not control** — purely read. Control stays Notion/Linear.
- **Auth:** needs push rights to the ref; `PlanAutoFetchService`'s default-branch-only logic does
  not apply (this is its own ref).
- **Migration:** additive; default off → no behavior change until opted in. Mirror files return to
  gitignored under `.switchboard/*`.