---
description: 'Remote control via API providers (incl. GitHub Issues) + agent activity light'
---

# Remote control via API providers (incl. GitHub Issues) + agent activity light

## Goal

Two independent workstreams:

**A. Put remote board control on the right foundation.** Retire the file-based git control plane
(board-state mirror + `GitStateProvider` + `manifest.json`-as-control) and make remote *control*
the job of non-branching **API providers** — Notion, Linear, and a new **GitHub Issues** provider
enabled by the 2026-07-02 GA of issue fields. Git keeps only what it's good at: durable authored
plan files.

**B. Agent activity light.** A per-card indicator that turns on at dispatch and off when the agent
signals completion (or a 20-minute timeout).

### Core problem & root cause (Workstream A)

Remote control was attempted through git-committed files, and that model is fundamentally broken:
- `exportStateToFile` rewrites the board mirror on every DB persist → **permanently dirty tree**,
  fighting `PlanAutoFetchService`'s clean-tree guard (patched piecemeal, e.g. `faf4d82`).
- The mirror and `manifest.json` are **single fixed-path mutable files** → concurrent branches
  merge-conflict or corrupt them (this repo merged conflicting PRs #26/#27 during investigation).
- consume-then-delete never reaps through git → state **resurrects** on fresh clones (PR #31's
  stranded manifest).

None of this is fixable in place — it's a property of using git files for **live mutable shared
state**. The correct model: live control state belongs to a **non-branching API provider**; git
carries only durable authored artifacts (plan files). Two providers already exist (Notion, Linear).
GitHub was previously rejected as a third because an Issue had only open/closed + labels (status
needed the separate, org-scoped Projects v2). **Issue fields (GA 2026-07-02)** put a native
single-select status directly on the issue (GraphQL `updateIssueFieldValue`), and **sub-issues**
give hierarchy — so GitHub Issues is now a viable third provider, uniquely living in the same repo
as the code.

### Design decisions (settled with the user)

- **Control = API providers only** (Notion, Linear, GitHub Issues). Retire the file-based control
  plane; the "git/github" remote option becomes the Issues provider.
- **Git carries durable facts only:** plan files (bodies + `**Epic:**`/`**Project:**` frontmatter),
  landed by auto-fetch. Never live column state.
- **Column is one-shot/live** → provider or DB, never a persistent frontmatter line.
- Activity light and its marker are decoupled from column moves (column moves happen in advance).

## How the Subtasks Achieve This

**Workstream A — Remote control on the right foundation**
- `github-issues-remote-provider.md` — new `GitHubIssuesRemoteProvider` on the existing
  `RemoteControlService` poll seam: single-select issue field → column, sub-issues → epic/subtask,
  issue comments → the `/comment` bridge. The third API provider.
- `retire-file-based-git-control-plane.md` — remove the mirror export, `GitStateProvider`, the
  `boardStateExport: control-plane|wiki` modes, and `manifest.json`-as-control; **repoint the git
  remote option to the Issues provider**. Keep plans-as-files + auto-fetch. Ship with/after the
  provider so there's never a gap.
- `plan-authoring-frontmatter-facts.md` — where the manifest's durable fields go: `**Epic:**` +
  `**Project:**` as per-plan frontmatter facts applied on import (apply-if-empty, auto-create the
  project row). The lightweight survivor of the dropped model-C reconciliation — no writeback, no
  ledger, because control is no longer git's job.
- `delete-epic-file-resurrect-fix.md` — independent correctness fix: `deleteEpic` tombstones the DB
  row but leaves the `.md`, so the watcher re-imports the "deleted" epic. Reap/neutralize the file.

**Workstream B — Agent activity light** (independent of A; build in this order; B-1 is its foundation)
- `working-state-model-and-dispatch-on.md` — `dispatched_at` column + migration; thread a `working`
  flag through the card payload + re-render signature; set ON at dispatch (`_recordDispatchIdentity`).
- `stage-complete-marker-clears-working-state.md` — parse `**Stage Complete:**` in the watcher and
  clear the flag.
- `stage-complete-prompt-directive.md` — inject a mandatory "append the marker when done" directive
  into every dispatched prompt.
- `working-state-timeout-sweep.md` — clear working state older than 20 min in the periodic scan.
- `card-working-light-ui.md` — render the light and ensure it re-renders on change.

Ordering — **A:** `github-issues-remote-provider` and `retire-file-based-git-control-plane` ship
together (never a gap in git-native control); `plan-authoring-frontmatter-facts` lands with the
retirement (it's where the manifest's fields go); `delete-epic-file-resurrect-fix` is independent.
**B:** B-1 first; B-2/B-4/B-5 depend on B-1; B-3 defines the marker B-2 parses. A and B are
independent of each other.

> **History:** earlier revisions of this epic tried to make git *files* carry control state (a
> `manifest.json` fix, then a model-C file↔DB reconciliation layer with carriers, writeback, and a
> ledger). That was abandoned once we established that live control state can't live in branchable
> git files and that GitHub Issues can now be a proper API provider. Only the durable-fact carriers
> (`**Epic:**`/`**Project:**`) and the delete-resurrect fix survived.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] (no subtasks)
<!-- END SUBTASKS -->
