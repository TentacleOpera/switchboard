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

1. **Provider class** implementing `RemoteProvider` (`pull: true`, `push: true`). Auth: a GitHub
   App / fine-grained PAT with **`Issues: write`** *and* **`issue_fields: read`** (the latter is
   required to discover org field definitions — without it calls fail with `Resource not
   accessible by integration`). Config in the DB config table under `remote.config`, provider key
   `github-issues`.
2. **Inbound (pull):** poll issues, read the "Switchboard Status" single-select field value →
   `stateKeyToColumn` → `onColumnMove` (echo-guarded by `target === current`). Read `parent`/
   `subIssues` → epic links; new issue comments → `onComment` (dedupe self via `author.login`).
3. **Outbound (push):** set the field via `setIssueFieldValues` (array of
   `IssueFieldCreateOrUpdateInput { fieldId, singleSelectOptionId }`); reparent via `addSubIssue`;
   set type via `updateIssue(issueTypeId:)`; comment via `addComment`. Reuse the `/comment`
   self-marker to prevent feedback loops.
   - **Create-then-Patch (design constraint):** `createIssue` / `POST …/issues` do **not** accept
     field values or issue type in the root payload. Creating a card is a two-step sequence —
     create the issue, then set field values + type + parent as a follow-up call. Handle partial
     failure between the two steps.
4. **Cursor / change detection:** poll with the search `updated:` qualifier
   (`repo:o/n type:issue updated:>=<cursor>`) — a field-value change **does** bump the issue's
   top-level `updatedAt`, so this catches column moves cheaply without scanning every issue. Field
   id + option ids are resolved once via the `issueFields` connection and cached per repo (handle
   option renames). (Optional accelerator: the `field_added` webhook fires on value set/update and
   carries previous+current — not required for v1, polling suffices and matches Notion/Linear.)
5. **Capabilities gate:** declare `{pull, push}` truthfully so the unified push seam
   (`remote-sync-refactor-1`) drives it correctly.

## Research findings (resolved 2026-07 — API is sufficient; verdict: fully viable)

API confirmed against GitHub GraphQL/REST schemas + changelog (issue fields GA 2026-07-02):
- **Fields:** create at org level (`createIssueField`); list per-repo via the `issueFields`
  connection; set values via `setIssueFieldValues` (array of `IssueFieldCreateOrUpdateInput`).
  Full REST parity (`GET`/`POST …/issues/{n}/issue-field-values`).
- **Change detection:** value change bumps `updatedAt`; poll via search `updated:>=<cursor>`.
  `field_added` webhook fires on value set/update with previous+current (optional accelerator).
- **Hierarchy:** `parent`/`subIssues` connections + `addSubIssue` mutation; `issueType` via
  `updateIssue(issueTypeId:)`. Limits: **max depth 8, max 100 sub-issues per level.**
- **Comments:** cursor-paginated `comments(after:)`; `author.login` reliably present for the
  echo-guard.
- **Poll cost:** ~1–2 GraphQL points/page (100 issues); a 2,000-issue full sync is <50 points,
  well under the 5,000/hr pool.

### ⚠️ Two caveats that shape the design
1. **Create-then-Patch** — issue creation can't set fields/type inline; always a two-step
   sequence (create → set field/type/parent). Handle partial failure.
2. **`issue_fields: read` scope** — required alongside `Issues: write`, or field calls fail with
   `Resource not accessible by integration`. In Actions, `GITHUB_TOKEN` needs it declared
   explicitly.

## User Review Required

- **Org-scope gate (the one real product decision):** issue fields are **organization-scoped and
  NOT available on standalone personal-account repos.** So a Switchboard user whose repo lives
  under a personal account cannot use this provider. Decide the fallback: require an org, use a
  dedicated tracking repo under an org, or fall back to Notion/Linear for personal-account users.
  Detect and message this at connect time.
- Confirm the field convention ("Switchboard Status") and whether Switchboard auto-creates the
  single-select field + options on first connect vs requiring pre-creation.
- Confirm planning issues live in the *code* repo vs a dedicated tracking repo.

## Complexity Audit

### Routine
- Implementing the `RemoteProvider` interface (Notion/Linear are the template).
- GraphQL calls for field read/set (`issueFields` / `setIssueFieldValues`) and sub-issue traversal.

### Complex / Risky
- **Field/option id resolution:** single-select writes need field id + option id; resolve once via
  `issueFields` and cache per repo; handle option renames.
- **Create-then-Patch partial failure:** an issue created but not yet field-stamped is a valid
  GitHub issue with no column — reconcile on the next poll (treat missing field as CREATED).
- **Org-scope availability:** gate the provider on org membership + issue-fields availability
  (Free/Team/Enterprise/GHEC orgs; GHES ≥ 3.19 per research, though the GA changelog cited 3.23 —
  confirm the exact GHES floor). Degrade gracefully; never offer it for personal accounts.
- **Sub-issue limits:** depth 8 / 100-per-level — fine for epics→subtasks, but guard against a
  pathological epic exceeding 100 children.

## Edge-Case & Dependency Audit

- **Depends on:** the remote-sync refactor's unified push/capability seam (`remote-sync-refactor-1`).
  Independent of the activity-light workstream.
- **Replaces:** the file-based git control plane (see `retire-file-based-git-control-plane.md`) —
  ship them together so there is always exactly one git-native control story.
- **Unique value vs Notion/Linear:** same repo as the code, no separate SaaS account, remote
  agent is already GitHub-connected.
- **Migration:** the file-based control plane is unshipped (no released users) → clean cut, no
  migration. Notion/Linear providers are untouched.
