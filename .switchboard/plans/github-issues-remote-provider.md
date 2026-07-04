# GitHub Issues remote-control provider (third API provider)

## Goal

Add GitHub Issues as a third **API-based** remote-control provider alongside Notion and Linear,
using the newly-GA (2026-07-02) **issue fields** feature. This replaces the file-based git
control plane (mirror export + `GitStateProvider` + manifest-as-control) with a provider that
lives in the same GitHub repo as the code and is immune to the branch/merge/dirty-tree problems
that made the file approach unworkable.

### Core problem & root cause

Remote *control* of the board (moving cards, seeing what exists) was attempted through
git-committed files: `exportStateToFile` writes `kanban-board.md` / `kanban-state-*.md`, and
`GitStateProvider` diffs `**Column:**` lines back. This is fundamentally broken:
- the mirror changes on every DB persist → **permanently dirty tree**, which fights
  `PlanAutoFetchService`'s clean-tree guard;
- a single fixed-path mutable file (mirror, and `manifest.json`) **cannot survive concurrent
  branches** — three branches writing it merge-conflict or corrupt;
- consume-then-delete never reaps through git, so state **resurrects** on fresh clones.

The correct model (settled with the user): **live mutable control state belongs to a
non-branching API provider, never git files.** Two such providers exist (Notion, Linear). The
reason GitHub was previously rejected as a third was that an Issue had only open/closed + labels;
any real status/column required **Projects v2** (a separate, org-scoped GraphQL surface a layer
removed from issues). 

### What changed (why it's viable now)

**Issue fields** went GA 2026-07-02: structured fields **directly on issues, independent of
Projects** — types single-select / text / number / date, with full REST + GraphQL for field
definitions and values. Confirmed API: the GraphQL `updateIssueFieldValue` mutation
(`UpdateIssueFieldValueInput { issueId, issueField { singleSelectOptionId | textValue } }`) sets
a value; field values are queryable per issue. Combined with **sub-issues** (parent/child, GA)
and **issue types** (GA, CLI/JSON-exposed), an Issue can now natively model a Switchboard card.

## Metadata

- **Project:** Switchboard
- **Tags:** remote-control, github, provider, integration, api
- **Complexity:** 7

## Design — map onto the existing `RemoteControlService` provider seam

`RemoteControlService` already polls provider APIs (no webhooks) and applies deltas via the same
path as a manual drag (`_remoteApplyColumnMove` → dispatch); providers implement
`RemoteProvider` with `RemoteProviderCapabilities`. Add a `GitHubIssuesRemoteProvider`:

| Switchboard concept | GitHub Issues primitive |
|---|---|
| Plan card | Issue (in the code repo) |
| Kanban column | **single-select issue field** (e.g. "Switchboard Status"; options = columns) |
| Epic → subtasks | **sub-issues** (parent issue = epic) |
| Project | an issue field or label |
| Card comment (`/comment` bridge) | issue comment |
| Complexity / tags | issue fields / labels |

1. **Provider class** implementing `RemoteProvider` (`pull: true`; `push: true` for high-fidelity
   mirroring like Notion/Linear). Auth via a GitHub App / token with `issues` read-write on the
   repo. Config stored in the DB config table under `remote.config` (same as other providers),
   provider key `github-issues`.
2. **Inbound (pull):** poll the repo's issues, read the "Switchboard Status" single-select field
   value → `stateKeyToColumn` mapping → `onColumnMove` (echo-guarded by `target === current`).
   Read sub-issue parent/child → epic links. Read new issue comments → `onComment`.
3. **Outbound (push):** on local column move / epic change / comment, set the issue field
   (`updateIssueFieldValue`), reparent sub-issues, or `createIssueComment`. Reuse the existing
   `/comment` self-marker to prevent feedback loops.
4. **Cursor / change detection:** poll on the existing cadence; use issue `updatedAt` (or a
   stored per-issue field-value fingerprint) as the cursor. If a `field`-value webhook/event
   proves reliable, add it as an accelerator later — not required for v1.
5. **Capabilities gate:** declare `{pull, push}` truthfully so the unified push seam
   (`remote-sync-refactor-1`) drives it correctly.

## User Review Required

- Confirm the field name/convention ("Switchboard Status") and whether Switchboard auto-creates
  the single-select field + options on first connect (via `createIssueField`) vs requiring the
  user to pre-create it.
- Confirm auth model (GitHub App vs PAT) and scope; confirm private + public repo handling
  (issue fields support per-field Public/Org visibility).
- Confirm whether planning lives as issues in the *code* repo or a dedicated tracking repo.

## Complexity Audit

### Routine
- Implementing the `RemoteProvider` interface (Notion/Linear are the template).
- GraphQL calls for field read/set and sub-issue traversal.

### Complex / Risky
- **Field/option id resolution:** single-select writes need the field id + option id (like
  Projects v2); cache them per repo and handle option renames.
- **Poll cost / rate limits:** confirm GraphQL point cost of reading field values across a repo's
  issues; page and cache. (Verify against GitHub GraphQL docs at implementation.)
- **Value-change events:** GA notes `field_added`/`field_removed` webhooks; confirm whether a
  value *change* fires an event. Polling covers it regardless (matches Notion/Linear).
- **Availability tiers:** issue fields GA for Free/Team/Enterprise/GHEC + GHES 3.23 — gate the
  provider on availability and degrade gracefully on older GHES.

## Edge-Case & Dependency Audit

- **Depends on:** the remote-sync refactor's unified push/capability seam (`remote-sync-refactor-1`).
  Independent of the activity-light workstream.
- **Replaces:** the file-based git control plane (see `retire-file-based-git-control-plane.md`) —
  ship them together so there is always exactly one git-native control story.
- **Unique value vs Notion/Linear:** same repo as the code, no separate SaaS account, remote
  agent is already GitHub-connected.
- **Migration:** the file-based control plane is unshipped (no released users) → clean cut, no
  migration. Notion/Linear providers are untouched.
