# The Pi Cannot Build, CI Can, and Nothing Connects the Two

## Goal

A team's commit is built and tested by GitHub Actions, and the reviewer is told the result for **the commit it was handed**. The board host never compiles anything.

### Problem analysis

**The box that runs the fleet cannot run the build.** Compilation and the test suite are the one genuinely heavy thing in this workflow, and they are the one thing a 4 GB Pi is bad at — the reason the seat-level split exists at all (`KanbanProvider.ts:6734` sets `skipTests: true` for lead, coder and intern and `false` for reviewer). But that split only helps when the *reviewer* sits on a machine that can build. On a Pi-only setup nobody can, and the split resolves to "nobody tests".

**The compute already has somewhere to go, and it is already paid for.** `.github/workflows/integration-tests.yml` runs `catalog:check`, `banner:check`, `compile-tests`, **`compile`**, `parity:check` and `push-routing:check` on GitHub's runners. That is precisely the work the Pi should not be doing.

**And it never runs on this workflow.** The triggers are:

```yaml
on:
  pull_request:
  workflow_dispatch:
  schedule:
    - cron: '0 9 * * 1'
```

**There is no `push:`.** This repository is worked directly on `main` — direct-to-main is deliberate here, not an accident — and PRs are not part of the loop. So a team commits, the head pushes, and **nothing runs**: no compile, no parity check, no push-routing check, until a human dispatches manually or the following Monday at 09:00.

So the expensive verification exists, is free, is already written, and is disconnected from the only path work actually takes.

**The reviewer has no way to learn the result either.** *The Reviewer Is Never Told What To Review* gives it a **review unit** — the commit resolved from stage trailers — but nothing tells it whether that commit built. It is asked to judge code it cannot compile, on a box that could not compile it anyway.

**Why not the alternatives.** Two adjacent ideas are already settled and should not be reopened:

- *Verification runner on another machine* (`BACKLOG`) is **withdrawn — "Do not code this."** It proposed a `verify` job kind with its own transport and verdict channel; the withdrawal is right that a second delegation path duplicates the coder→reviewer handoff.
- **Seating the reviewer in the cloud** trades the wrong thing. The reviewer's value is judgement on a local commit; hosting it remotely moves the judgement away from the code to rent compute needed for twenty minutes.

This card moves **only the compute**, over a transport every developer already understands: `git push`. No new delegation path, no escalation directive, no agent instruction to remember.

## Metadata

- **Complexity:** 4
- **Tags:** ci, reviewer, raspberry-pi, reliability

## User Review Required

None.

## Proposed Changes

### 1. Run the workflow on push

Add a `push:` trigger so a team's commit is actually built. Without it the rest of this card has nothing to read.

**Scope it deliberately.** Every push spending six jobs of runner time is a real cost on a busy board — this repository takes many small commits a day. Restrict by path so a plan-file or docs commit does not trigger a compile: the checks care about `src/`, `cmd/`, `internal/`, `package.json` and the workflow itself. A commit touching only `.switchboard/` should run nothing.

### 2. Resolve the run for a specific commit

Given a commit SHA, return its check status: pending, success, or failure with the failing job. `gh` (2.45.0, present) does this in one call; the board should not reimplement the API.

**Report the SHA it answered for.** A status resolved for the wrong commit — HEAD instead of the reviewed commit, say — is worse than no status, because it reads as evidence. Return `{ sha, state, jobs }` and let the caller check the SHA matches what it asked about.

### 3. Put it in the reviewer's prompt, beside the commit

*The Reviewer Is Never Told What To Review* already resolves the review unit from stage trailers and names it. This adds one line next to it: the CI state for that same commit.

Three states, three different instructions, and they must not collapse into one:

- **Success** — the suite passed on this commit. Review judgement, not mechanics.
- **Failure** — name the failing job. A reviewer that reruns a suite CI already failed is wasting the box the split exists to protect.
- **Pending or absent** — say so plainly. **Do not** tell the reviewer to wait, and do not block the review: an unpushed commit, a path-filtered commit and a queued run are all legitimately "no result", and none of them means the work is bad.

**Degrade to today's behaviour.** With no CI configured, no network, or no run for the commit, the prompt is exactly what it is now. This must never become a dependency that stops a review happening.

### 4. Do not make CI a gate

The board must not withhold, block or auto-fail a card on CI state. Completion is asserted by the agent that did the work; this is **evidence handed to a reviewer**, not a new authority over the pipeline. A red run on a commit whose failure is unrelated must not strand work.

## Edge-Case & Dependency Audit

1. **Depends on `75a2d809`** for the commit identity. Without stage trailers there is no SHA to ask about, and this card has nothing to key on.
2. **Push is not guaranteed.** A head may commit and not push — the SSH plan's change 5 covers reachability for a different reason, and the same gap bites here: no push, no run, no status. Report it as "not pushed", distinctly from "no result".
3. **`gh` needs credentials the board may not have.** It is present on this machine and authenticated for this operator; it will not be on a fresh install. Absent or unauthenticated `gh` degrades to no status, never to an error that blocks a dispatch.
4. **Runner minutes are a real budget.** Path filtering in change 1 is what keeps this from turning every plan edit into a build. Private-repo minutes are metered.
5. **A queued run is the common case for a fast reviewer.** The reviewer will often be prompted seconds after the push. "Pending" must read as normal, not as a problem.
6. **CI tests the pushed commit, not the working tree.** A reviewer must treat green as evidence about the commit, not about anything uncommitted beside it. Say so in the prompt line.

## Verification Plan

1. A commit touching `src/` triggers the workflow on push; one touching only `.switchboard/plans/` triggers nothing.
2. Given a SHA, the resolver returns its state and the SHA it answered for, and a caller passing an unknown SHA gets "no result" rather than HEAD's.
3. A reviewer dispatched for a commit with a green run sees that in its prompt, naming the commit.
4. A red run names the failing job.
5. A pending run, an unpushed commit, and a repository with no CI each produce a distinct, plainly worded line — and in all three the review still happens.
6. With `gh` absent or unauthenticated, dispatch is unaffected and the prompt matches today's exactly.
7. No card is blocked, failed or held by CI state under any of the above.
