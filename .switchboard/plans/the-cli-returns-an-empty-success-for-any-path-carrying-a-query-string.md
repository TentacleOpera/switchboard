# A Stale CLI Binary Answers Every Board Read With an Empty Success

## Goal

Make the `switchboard` binary agents invoke either match the source it was built from, or say
that it does not. Today a months-old build returns `200` with an empty array for any path
carrying a query string — the one answer an agent cannot distinguish from "the board has
nothing in that column" — and nothing anywhere reports that the artifact is out of date.

> **Title note.** This card was filed as "The CLI Returns an Empty Success for Any Path Carrying
> a Query String" on the measured symptom. The CLI source is correct; the binary was stale. The
> symptom is preserved in the analysis because it is how this will be noticed again.

> **`curl` appears below as a diagnostic control, never as an access path.** Agents reach the
> board through `switchboard api` and nothing else: the CLI owns port discovery, the `/health`
> probe, auth-token attachment and `workspaceRoot` injection, and a per-feature worktree has
> neither a port file nor a token file for `curl` to use. It is used here only to hold the
> endpoint fixed while the CLI varied, which is what proved the endpoint innocent.

### Problem analysis

**Measured 2026-09-11, against the running host on :7777, single workspace root, correctly
selected.** Same endpoint, same second:

| call | rows |
| :--- | ---: |
| `switchboard api GET "/kanban/features"` | 106 |
| `curl "…/kanban/features"` | 106 |
| `switchboard api GET "/kanban/plans?column=BACKLOG"` | **0** |
| `curl "…/kanban/plans?column=BACKLOG"` | **57** |
| `switchboard api GET "/kanban/plans?column=CREATED"` | **0** |
| `curl "…/kanban/plans?column=CREATED"` | **123** |

The split is exact: a path with **no** query string round-trips correctly; a path **carrying**
one comes back empty. Adding `&workspaceRoot=<root>` explicitly makes it work again, which is
what disguised this as a scoping problem on first sight — it is not. `/health` reports one root
and `selectedWorkspaceRoot` matching it, and `curl` with no scoping at all returns the rows.

**The endpoint is not at fault.** `_handleGetPlans` resolves the board through `_resolveBoard`
for both the filtered and unfiltered cases and applies an exact `kanbanColumn === column`
filter. `curl` proves that path returns 123 rows unscoped. The defect is between the CLI's
argument and the request it issues.

**Why this is worse than a broken call.** The failure is an empty success. An agent asking
"what is in CODE REVIEWED" is told "nothing", not "that did not work" — the precise shape
`a-plan-whose-file-is-gone-answers-200-with-an-empty-body.md` exists to kill, reached by a
different route. Nothing in the response distinguishes it from an empty column.

**And every documented example is the failing form.** `query-kanban/SKILL.md` is the skill
agents are told to use for board reads, it was rewritten to be endpoint-only, and its examples
are:

```bash
switchboard api GET "/kanban/plans?column=PLAN%20REVIEWED"
switchboard api GET "/kanban/plans?column=BACKLOG"
switchboard api GET "/kanban/plans?featureId=<featurePlanId>"
```

All carry a query string. All return zero. The file mentions `workspaceRoot` once. The same
form was written into two `ScheduledJobsService` job prompts on 2026-09-11.

**RESOLVED 2026-09-11, before this plan was picked up.** The matrix was re-run against current
source and the CLI is **not** defective:

| built from | `api GET "/kanban/plans?column=BACKLOG"` |
| :--- | ---: |
| current source (`out/standalone/cli.js`) | returns rows |
| shipped binary (`dist/linux-amd64/switchboard`, 2026-09-06) | `{"data": []}` |

So `switchboard api` works as designed today. `apiRequest` takes `pathname` and an optional
structured `query`, merges `workspaceRoot` in for read-like methods, and appends with
`url.includes('?') ? '&' : '?'` so an embedded query string is extended rather than collided
with. `cmdApi` hands it the raw argv path and lets that logic do the work, which is correct.

**The real finding is the artifact, not the code.** `dist/` is gitignored — zero tracked files —
so it is a local build, never shipped through the repo. The binary on this machine is dated
2026-09-06 while both relevant source lines landed 2026-09-03 (`96fb16df`), so it does not
correspond to the source beside it and cannot be dated by its own mtime.

That is the thing worth fixing, and it is larger than one endpoint:

- **Agents are told to invoke that exact binary.** Dispatch prompts name
  `"/home/patrick/switchboard/dist/linux-amd64/switchboard"`, and the skills invoke
  `switchboard api`. Whatever is on disk is what every agent board read goes through.
- **Its failure mode is an empty success.** A stale binary does not announce itself. It returns
  a well-formed `200` with `data: []`, which an agent cannot distinguish from an empty column.
  Every documented example in `query-kanban/SKILL.md` carries a query string, so on this
  machine all of them silently return nothing.
- **For the Pi product the binary IS the artifact.** There, staleness is not a local-hygiene
  problem — it is what users run.

### Root cause

A build artifact that agents depend on, that nothing verifies, and whose staleness is
indistinguishable from a correct empty answer. Nothing rebuilds it on a source change, nothing
compares it against the source it sits next to, and no caller can tell an old binary from a new
one — so it degrades silently and indefinitely.

Two earlier theories are recorded because both looked right and both were wrong: first that
this was workspace scoping (adding `&workspaceRoot=` makes it work, which is a symptom of the
duplicate-param ordering, not the cause), then that the endpoint's column filter was at fault
(`curl` returns 123 rows against the same URL).

### Non-goals

- Changing `_handleGetPlans` or any read endpoint. `curl` demonstrates they are correct.
- The board's storage topology. Unrelated.
- Adding `workspaceRoot` to every documented example as the remedy. That masks the defect
  rather than fixing it, and leaves the next unscoped call silently empty.

## Metadata

**Complexity:** 4
**Tags:** cli, devops, reliability, infrastructure, docs

## User Review Required

None.

## Complexity Audit

### Routine
- The CLI source is correct: `apiRequest` (`cli.ts:590`) merges `workspaceRoot` for read-like methods and appends with `url.includes('?') ? '&' : '?'`, so an embedded query string is extended, not collided. No fix to `cmdApi`/`apiRequest` is owed.
- Embedding the build commit in `--version` and `/health` is a build-time injection into an existing string field.

### Complex / Risky
- Provenance in `--version` is a postmortem tool, not a prevention: an agent invoking `switchboard api` in a dispatch prompt never runs `--version`. The load-bearing fix is a rebuild wired into the loop that matters (CLI/API source change → `dist/` rebuilt), so the artifact agents invoke can't drift.
- `dist/` is gitignored (zero tracked files), so nothing compares the binary against the source beside it; the rebuild step must run on the surfaces the binary serves, not on every build.
- Re-verifying `query-kanban/SKILL.md` examples and the two `ScheduledJobsService` job prompts is a docs contract — they were written against a stale binary's behaviour and currently all return zero.

## Edge-Case & Dependency Audit

- **Race Conditions:** none — the binary is a static artifact; staleness is a build-ordering problem, not a runtime race.
- **Security:** provenance must not leak secrets; the build commit is a public SHA.
- **Side Effects:** a rebuild loop that runs too broadly slows the dev cycle; scope it to CLI/API-surface changes, not every source edit.
- **Dependencies & Conflicts:** none within this feature — the CLI talks to whichever host is serving, so the fix is host-agnostic. The empty-success theme is shared with the plan-gone card (`19ac4972`) but on a different surface (binary staleness vs. plan-endpoint content); no shared code to reconcile.

## Dependencies

- None blocking. The CLI source is correct; this card is about the artifact, not the code.

## Adversarial Synthesis

Key risks: provenance alone leaves staleness silent for any agent that invokes the binary without checking; a rebuild loop scoped too broadly slows the dev cycle. Mitigations: lead with the rebuild wired into CLI/API-surface changes (the prevention), with provenance as the diagnostic; re-verify the skill's documented examples as a contract test so a rewrite cannot reintroduce a form that silently answers empty.

## Proposed Changes

1. **The binary states its provenance.** `switchboard --version` (and the `/health` payload)
   should carry the commit it was built from, so "is this binary current?" is answerable without
   running a differential against source.
2. **Staleness is detectable, not silent.** The host already knows its own version; a CLI whose
   build predates the running host should say so rather than issue requests that quietly differ.
3. **A rebuild is part of the loop that matters.** Whatever refreshes `dist/` must run when the
   CLI or the API surface changes — otherwise the artifact every agent invokes drifts from the
   source every gate is green against.
4. **Re-verify the skill's examples against a freshly built binary**, and the two
   `ScheduledJobsService` job prompts repointed at this same form — they were written against
   the behaviour of a stale binary.
5. **No fix to `cmdApi` or `apiRequest` is owed.** They are correct. A change there would be a
   fix to the wrong layer.

## Verification Plan

- **Parity matrix:** for `/kanban/plans?column=<id>`, `/kanban/plans?featureId=<id>` and
  `/kanban/board`, assert a freshly built CLI and a direct HTTP request return identical row
  counts against the same host. The direct request is the test's control only — it is not a
  path any agent may take.
- **Staleness is visible:** point an old binary at a newer host and assert it reports the
  mismatch rather than returning rows that silently differ.
- **No empty success on a mangled request:** force the failure mode and assert a non-zero exit
  and a stated reason, never `data: []`.
- **Documented examples execute:** assert every `switchboard api` invocation in
  `query-kanban/SKILL.md` returns rows against a board known to have them — the examples are
  the contract, and they are currently all broken.
- **Both hosts:** the CLI talks to whichever host is serving, so assert against the standalone
  host and the extension host alike.

### Goal Invariants

- **CLI and HTTP agree:** assert no endpoint returns different rows through a current CLI than
  through a direct request to the same URL.
- **Provenance is reportable:** assert the CLI can state the commit it was built from, so a
  stale artifact is identifiable rather than inferable only from wrong answers.
- **The skill's examples are executable:** assert as a contract test that the documented
  invocations parse and return rows, so a rewrite of the skill cannot reintroduce a form that
  silently answers empty.
