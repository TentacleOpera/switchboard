# Board-state read snapshot (isolated ref, one-directional)

**Plan ID:** 6ae9074e-3114-490f-bc8b-3dec2dfda088

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
- **Tags:** infrastructure, backend
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
- **Artifacts:** `board.json` (machine-readable: `plan_id → {topic, column, feature, project}`,
  ordered by `updated_at DESC` — there is no explicit `order` column in the DB schema; board layout
  is implicit by `updated_at`) + `board.md` (human table). Keep it small — plans already carry
  content + project/feature frontmatter, so the snapshot's unique job is *current column + layout*.
- **Publish:** commit to the orphan ref and **force-push** (orphan branches don't fast-forward from
  `main`); single-flight; exclude the ref from CI triggers / branch protection. Lift the git
  commit+push plumbing from the retired `GitStateProvider.pushExportedState` (`:306-393`), but
  **drop the rebase/merge reconciliation** (`:325-343`) — that logic is for fast-forward merges on
  the current branch and does not apply to an orphan ref; force-push the snapshot directly.
- **Setting:** the existing `boardStateExport` enum (`none`/`control-plane`/`wiki`,
  `package.json:537-553`) does not map cleanly to the orphan-branch model — add a new enum value
  (e.g. `read-only-snapshot` or `orphan-branch`) for this mode; the `control-plane`/`wiki` values
  are removed by `retire-file-based-git-control-plane.md`. Default stays opt-in (off → `none`).

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

## Dependencies

- `retire-file-based-git-control-plane.md` — removes the bidirectional mirror + `GitStateProvider`
  (this plan replaces the *read* half only). The `pushExportedState` plumbing this plan lifts comes
  from the retired `GitStateProvider.ts:306-393`; lift it before that file is deleted, or extract it
  into a shared helper first. Must land with/before the mirror removal so read-visibility is never
  lost.
- No dependency on `plan-authoring-frontmatter-facts.md` or `delete-epic-file-resurrect-fix.md`.

## Adversarial Synthesis

Key risks: (1) No `order` column exists in the DB schema — `board.json` cannot emit a numeric
`order` field; consumers must sort by `updated_at DESC` (the `getBoard` query at
`KanbanDatabase.ts:2696-2705` already does). Mitigation: omit `order` from `board.json`, document
that ordering is by `updated_at`, or derive a synthetic index from the query result order. (2) No
debounce exists on the current `exportStateToFile` (fire-and-forget at `:6679`) — without debounce +
content-hash, the snapshot republishes on every no-op persist. Mitigation: reuse the content-hash
pattern from `KanbanProvider.ts:1461-1470` (SHA256 of the serialized state) and the debounce pattern
from `GlobalPlanWatcherService.ts:421-443`. (3) Orphan-branch creation (`git checkout --orphan`) has
no existing code in the repo — first-publish must handle the branch-absent case (create orphan, commit, push)
vs. the update case (checkout existing, overwrite, force-push). (4) Multi-writer: two machines
publishing → last-write-wins is correct (DB is authority), but interleaved partial pushes must be
avoided — the single-flight pattern from `GitStateProvider.ts:307-310` prevents this. Mitigations
converge: content-hash + debounce + single-flight + force-push.

## Proposed Changes

### New file: `src/services/BoardSnapshotPublisher.ts`

- **Context:** No orphan-branch code exists in the repo. The git commit+push plumbing lives in the
  retired `GitStateProvider.pushExportedState` (`:306-393`), but its rebase/merge reconciliation
  (`:325-343`) is for fast-forward merges and does not apply to an orphan ref.
- **Logic:** New service that:
  1. Reads board state via `db.getBoard(workspaceId)` (`KanbanDatabase.ts:2696-2705`) — returns
     `KanbanPlanRecord[]` ordered by `updated_at DESC`.
  2. Serializes to `board.json` (`plan_id → {topic, column, feature, project}`, array order =
     board order) + `board.md` (human table). No `order` field (not in schema); no timestamp
     (content-stable).
  3. Computes a SHA256 content hash (reuse pattern from `KanbanProvider.ts:1461-1470`); if the hash
     matches the last published hash, skip (content-stable — no republish on no-op persist).
  4. Debounced (reuse pattern from `GlobalPlanWatcherService.ts:421-443`, ~500ms) + single-flight
     (reuse `_inFlight`/`_pending` pattern from `GitStateProvider.ts:307-310`).
  5. Publish: `git checkout --orphan switchboard/board` (first publish) or `git checkout
     switchboard/board` (update); `git add board.json board.md`; `git commit -m "switchboard: board
     snapshot"`; `git push --force origin switchboard/board`. No rebase/merge (orphan ref doesn't
     fast-forward from `main`). Restore the original branch checkout afterward.
- **Implementation:** Write `board.json` / `board.md` to a temp dir (not the working tree — the
  snapshot must not dirty the code branches), or use a separate git worktree at the orphan ref. The
  latter is cleaner (no branch-switching in the user's working tree) but adds worktree lifecycle
  complexity; the former is simpler but must carefully save/restore HEAD.
- **Edge Cases:** (a) First publish (branch absent) — `git checkout --orphan` creates it; (b)
  branch already exists — `git checkout` then overwrite (orphan branch has no history to preserve);
  (c) push fails (no remote, no auth) — warn and retry on next cycle; (d) two machines publish —
  last-write-wins via force-push (DB is authority); (e) the orphan ref must not trigger CI —
  confirmed: `.github/workflows/integration-tests.yml` only triggers on `pull_request` (orphan
  pushes are not PRs).

### `src/services/KanbanDatabase.ts` — trigger the snapshot publisher on persist

- **Context:** `_persist` calls `exportStateToFile` (fire-and-forget, `:6679`). The snapshot
  publisher needs a similar hook.
- **Logic:** After `_persist`, if `boardStateExport === 'read-only-snapshot'` (the new enum value),
  call `BoardSnapshotPublisher.publish()` (debounced + content-stable inside the publisher). Do NOT
  call it on every persist — the debounce + content-hash inside the publisher handles coalescing.
- **Edge Cases:** The publisher must not block `_persist` (fire-and-forget, like
  `exportStateToFile` today).

### `package.json` — add `read-only-snapshot` enum value

- **Context:** `switchboard.boardStateExport` (`:537-553`) defines `none`/`control-plane`/`wiki`.
  `control-plane`/`wiki` are removed by `retire-file-based-git-control-plane.md`.
- **Logic:** Add `read-only-snapshot` to the enum (or `orphan-branch`); default stays `none`
  (opt-in/off).
- **Edge Cases:** Existing configs with `control-plane`/`wiki` fall back to `none` once those values
  are removed (unreleased feature, acceptable).

### `src/services/SetupPanelProvider.ts` + `src/webview/setup.html` — UI for the snapshot opt-in

- **Context:** The `boardStateExport` dropdown (`setup.html:733-737`) renders the current modes.
- **Logic:** Replace the `control-plane`/`wiki` options with a `read-only-snapshot` option (off by
  default). Update `SetupPanelProvider.ts` (`:313`, `:322`) to write the new value.
- **Edge Cases:** The dropdown should make clear this is read-only (no control) to set expectations.

## Verification Plan

### Automated Tests

> Per session directive: automated tests skipped. Verification is manual code-review only.

### Manual Verification

1. **First publish (branch absent):** Enable `read-only-snapshot`; move a card → confirm
   `switchboard/board` orphan branch is created with `board.json` + `board.md`; confirm the working
   tree branch is restored afterward (user is not left on `switchboard/board`).
2. **Content-stable:** Move a card, then trigger a no-op persist (e.g. re-save a plan file without
   changes) → confirm the snapshot is NOT republished (content hash unchanged → skip).
3. **Debounce:** Rapidly move 5 cards in succession → confirm a single snapshot publish (debounce
   coalesces), not 5.
4. **Update (branch exists):** Move a card after the first publish → confirm `switchboard/board` is
   updated (force-push), not a new branch.
5. **Multi-writer:** (If testable) Two machines with the snapshot enabled → confirm last-write-wins
   via force-push; confirm no interleaved partial push (single-flight).
6. **CI isolation:** Confirm an orphan-ref push does NOT trigger
   `.github/workflows/integration-tests.yml` (it only fires on `pull_request`).
7. **Default off:** With `boardStateExport: none` (default), confirm no snapshot is published and no
   orphan branch is created.
8. **Remote fetch:** From a remote agent, `git fetch origin switchboard/board && git show
   switchboard/board:board.json` → confirm the board state is readable.

## Recommendation

Complexity 5 → **Send to Coder**.