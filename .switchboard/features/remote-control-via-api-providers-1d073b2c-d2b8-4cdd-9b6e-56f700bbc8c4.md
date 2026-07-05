---
description: 'Remote control + board read-visibility via API providers (Notion, Linear); retire the file-based git control plane'
---

# Remote control via API providers

**Complexity:** 6

## Goal

Put remote board **control** and **read-visibility** on the right foundation. Retire the file-based
git control plane (board-state mirror + `GitStateProvider` + `manifest.json`-as-control) and make
remote *control* the job of non-branching **API providers** — Notion and Linear. Board
*read-visibility* (a remote git agent seeing what cards exist and their columns) moves to a
one-directional, content-stable snapshot on an orphan branch. Git keeps only what it's good at:
durable authored plan files.

> **Scope note.** The agent activity-light work that used to live here is now its own feature
> ("Agent activity light") — it shares no code, dependency, or ordering with this one.

### Core problem & root cause

Remote control was attempted through git-committed files, and that model is fundamentally broken:
- `exportStateToFile` rewrites the board mirror on every DB persist → **permanently dirty tree**,
  fighting `PlanAutoFetchService`'s clean-tree guard (patched piecemeal, e.g. `faf4d82`).
- The mirror and `manifest.json` are **single fixed-path mutable files** → concurrent branches
  merge-conflict or corrupt them (this repo merged conflicting PRs #26/#27 during investigation).
- consume-then-delete never reaps through git → state **resurrects** on fresh clones (PR #31's
  stranded manifest).

None of this is fixable in place — it's a property of using git files for **live mutable shared
state**. The correct model: live control state belongs to a **non-branching API provider** (Notion,
Linear); git carries only durable authored artifacts (plan files) plus a one-directional read-only
board snapshot that never merges into the code branches.

### Design decisions (settled with the user)

- **Control = API providers only** (Notion, Linear). Retire the file-based control plane entirely.
- **Board read-visibility = one-directional snapshot** on an orphan branch `switchboard/board`:
  the extension is sole writer, always overwrite, no diff-ingest, no control, no per-persist
  timestamp. Emits `board.json` + `board.md`. Never bidirectional, never on the code branches → no
  dirty tree, no merge conflicts, no resurrection.
- **Git carries durable facts only:** plan files (bodies + `**Feature:**`/`**Project:**` frontmatter),
  landed by auto-fetch. Never live column state.
- **Column is one-shot/live** → provider or DB, never a persistent frontmatter line.
- **GitHub Issues as a git-native provider was considered and dropped.** Issue fields / types /
  sub-issues are **organization-scoped** — unavailable on personal-account repos even on paid
  plans — so for the solo-dev majority it would require creating an org + transferring the repo,
  more friction than Notion/Linear.

## How the Subtasks Achieve This

- `retire-file-based-git-control-plane.md` — remove the mirror export as a *control* channel,
  `GitStateProvider`, the `boardStateExport: control-plane|wiki` diff/control modes, and
  `manifest.json`-as-control. Keep plans-as-files + auto-fetch. Hands board read-visibility to the
  snapshot subtask below (visibility is relocated, not deleted).
- `board-state-read-snapshot.md` — the read-visibility half: a one-directional, always-overwrite
  snapshot (`board.json` + `board.md`) published to the orphan branch `switchboard/board`. Sole
  writer is the extension; content-stable (no per-persist timestamp); default opt-in (off).
- `plan-authoring-frontmatter-facts.md` — where the manifest's durable fields go: `**Feature:**` +
  `**Project:**` as per-plan frontmatter facts applied on import (apply-if-empty, auto-create the
  project row). No writeback, no ledger — control is no longer git's job.
- `delete-epic-file-resurrect-fix.md` — independent correctness fix: `deleteFeature` tombstones the DB
  row but leaves the `.md`, so the watcher re-imports the "deleted" feature. Reap/neutralize the file.

Ordering — `board-state-read-snapshot` lands with/before the mirror removal in
`retire-file-based-git-control-plane` so remote read-visibility is never lost; control is already
served by the existing Notion/Linear providers, so there is no control gap; `plan-authoring-
frontmatter-facts` lands with the retirement (it's where the manifest's fields go);
`delete-epic-file-resurrect-fix` is independent.

> **History:** earlier revisions of this feature tried to make git *files* carry control state (a
> `manifest.json` fix, then a model-C file↔DB reconciliation layer with carriers, writeback, and a
> ledger), and briefly proposed a GitHub Issues API provider as a third control channel. All were
> abandoned: live control state can't live in branchable git files, and GitHub issue fields are
> org-scoped (unusable for personal-account solo devs). What survived: control on the existing
> Notion/Linear providers, a one-directional read-only board snapshot for visibility, the
> durable-fact carriers (`**Feature:**`/`**Project:**`), and the delete-resurrect fix.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Delete-feature (and delete-plan) file-resurrect fix](../plans/delete-epic-file-resurrect-fix.md) — **CREATED**
- [ ] [Plan-authoring frontmatter facts (feature + project on import)](../plans/plan-authoring-frontmatter-facts.md) — **CREATED**
- [ ] [Retire the file-based git control plane; hand board visibility to the read-only snapshot](../plans/retire-file-based-git-control-plane.md) — **CREATED**
- [ ] [Board-state read snapshot (isolated ref, one-directional)](../plans/feature_plan_20260704_224822_board_state_read_snapshot_isolated_ref_one_directional.md) — **CREATED**
<!-- END SUBTASKS -->
