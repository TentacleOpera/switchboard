# Multi-Agent Planning 01 — Fan-In Dispatch: N Agents, One Problem, N Independent Plans

## Metadata

**Complexity:** 5
**Tags:** planning, orchestration, dispatch, multi-agent

## Goal

Add a planning run mode that dispatches N agents at a *single* problem from different investigative entry points, each producing a complete, independent plan into an isolated run directory, with cross-agent communication deliberately suppressed for the duration.

This plan owns dispatch and artifact isolation only. Comparing the resulting plans is `multi-agent-planning-02-divergence-map.md`; resolving their disagreements is `multi-agent-planning-03-adjudication-round.md`. Shipping this plan alone is already useful: it produces N plans in a run directory that a human can diff by hand.

### Problem analysis and root cause

**The problem being solved is anchoring in single-agent planning.** One planner explores a codebase, forms a root-cause hypothesis early, and spends the rest of its budget elaborating that hypothesis rather than challenging it. The output is a plan that reads as complete and rests on a false premise. The cost lands downstream — a coding cycle, a review pass, rework, and sometimes a bad merge — which makes planning the highest-leverage place in the pipeline to spend redundant compute.

This repository is unusually hostile to obvious readings, and its own `CLAUDE.md` is the evidence: the plan importer is resolve-only rather than auto-creating projects; `window.confirm()` is a silent no-op in VS Code webviews; `dist/` is not used during development. Each of those is a trap where the natural assumption is wrong. A single planner that anchors on the natural assumption emits a confidently wrong plan. N *independent* planners will tend to diverge at exactly those points, and the divergence is the alarm.

Independent sampling is what buys this: N agents that never see each other's work produce **uncorrelated** errors. Agreement then constitutes evidence, and disagreement localizes the real uncertainty. Coordination during generation destroys that property — agents who read each other's findings anchor collectively, and four agents in confident agreement about a fiction is the worst available outcome because it looks like success.

**Root cause of why this cannot be done today — three distinct blockers, all verified against the tree:**

1. **No fan-in dispatch shape exists.** `switchboard.triggerBatchAgentFromKanban` is the batch primitive, and every call site is fan-*out*: `KanbanProvider.ts:5683` dispatches role `planner` with skill `improve-plan` across a list of `dispatchIds`, one plan per agent. Also `:7275`, `:7322`, `:8659`. The mapping is 1 plan : 1 agent. What this plan needs is the transpose — 1 problem : N agents — and no call path produces it.

2. **Draft plans cannot be written to `.switchboard/plans/`.** That directory is watched and auto-imported: `TaskViewerProvider.ts:15110-15117` enumerates it via `_listSupportedLocalPlanPaths`, and watchers are registered at `:13319` and `:14063`. Writing N drafts per run into it would import N junk cards onto the board every run, and the user would have to delete them by hand. Run artifacts must therefore live outside the watched tree.

3. **Nothing suppresses cross-agent communication.** The link-up path exists (`src/webview/terminals.js:6073+`, relayed via `/terminals/verb/ptySendPrompt`) and, per the current design, has moved to standing orders injected into every prompt. Standing orders that tell an agent to check a team inbox are exactly wrong during generation. There is no notion of a *run-scoped* standing-order override that can turn comms off for one phase.

**A contract correction that affects implementation.** `switchboard-contracts` #2 defines completion as the first plan-file `mtime` advance after `dispatched_at` is set, and #3 makes plan files write-once-at-the-end for dispatched coders. Both govern *a dispatched card's own plan file*. Phase-1 investigators are writing **new** files into a run directory and are not dispatched cards in that sense, so neither contract detects their completion. Run completion needs its own mechanism, and reusing the mtime gate here would be a category error.

**Blast radius.** Additive. No existing dispatch path changes shape; the plan watcher is untouched; the board gains nothing until plan 02 emits a synthesized plan into `.switchboard/plans/`.

## User Review Required

Two decisions the user should make before this is coded, because both are cheap to set now and annoying to change later:

1. **Fleet size and entry points.** The design assumes four: failing behavior / tests and contracts / git history / architecture. Fewer than three loses the divergence signal; more than about five is mostly duplicated exploration.
2. **Whether the brief is human-reviewed before dispatch.** The brief is the single point of failure — N agents working from a bad brief produce N bad plans. Recommend a review gate for the first several runs, then make it optional.

## Complexity Audit

### Routine

- Creating a run directory and writing per-agent output paths into it.
- Assigning a role/entry point per terminal from a static list.
- Reusing the existing PTY dispatch path to deliver a prompt to an idle terminal.

### Complex / Risky

- **The brief must not contain the lead's diagnosis.** The natural instinct when composing a brief is to share what is already suspected, and one such sentence anchors every investigator, destroying the independence the run exists to buy. The brief carries symptom, scope, required sections and the entry-point assignment — never a root cause. This is the single most important behavioural constraint in the plan and it is a prompt-authoring discipline, not a code path, so it needs an explicit guard (see Implementation 6).
- **Comms suppression must be enforced, not requested.** "Do not read the other agents' output" as advisory prose will be violated eventually, and a violation is invisible in the output — a plan that quietly incorporated a neighbour's finding looks identical to one that didn't. Prefer a mechanism the agent cannot ignore: give each investigator a path only to *its own* output file, and keep sibling drafts out of any directory it is pointed at.
- **Run completion detection is new work.** See the contract correction above. Options: watch for N expected files to appear in the run directory, or have each investigator write a sentinel. The file-appearance watcher is preferable because it needs no cooperation from the agent, but it must tolerate a partially-written file (write to a temp name, rename into place) or the lead will read a truncated plan.
- **Partial runs are the normal case, not the exception.** One investigator will die, wedge, or produce three thin paragraphs. The run must complete on a quorum rather than blocking on all N, and a thin contribution must be *discardable* rather than averaged in. Design the completion condition as "quorum reached or deadline exceeded", never "all N".
- **Standing-orders integration point is newer than the tree.** The current standing-orders mechanism postdates the code readable at this commit, so this plan names the integration by behaviour ("suppress the team-inbox check for the duration of phase 1") rather than by line number. Whoever codes it should locate the live injection site first.

## Edge-Case & Dependency Audit

**Race Conditions** — N investigators writing concurrently into one run directory. Distinct filenames per agent make this safe, but each write must be atomic (temp file + rename) so the lead's watcher never observes a half-written plan. If the lead begins reading on the *first* file rather than on quorum, it will anchor on whichever agent finished first, which reintroduces the exact bias the run exists to remove — so the read must not start until the completion condition fires.

**Security** — no new surface. Dispatch uses the existing authenticated verb rail; the run directory is inside the workspace.

**Side Effects** — the run directory is new state under `.switchboard/`. It must NOT be under `.switchboard/plans/` (blocker 2 above). `.switchboard/planning-runs/<run-id>/` is proposed. Since this directory has never existed in a released version, per the repo's migration rule it can take clean breaks with no compat shim. Consider whether run directories should be pruned or archived — N plans per run accumulates.

**Dependencies & Conflicts** — no conflict with the plan watcher provided the run directory stays outside `.switchboard/plans/`. Adjacent to but independent of the existing planner batch dispatch at `KanbanProvider.ts:5683`, which keeps its 1:1 semantics untouched. Blocks plan 02, which consumes the run directory this plan produces.

## Dependencies

None. This is the first plan of the three.

## Implementation

1. Define the run directory layout — `.switchboard/planning-runs/<run-id>/` containing `brief.md` and one `plan-<agent>.md` per investigator. Confirm nothing in the plan-watcher enumeration path (`TaskViewerProvider.ts:15110-15117`) reaches it.
2. Add a brief author step: from the problem statement, emit `brief.md` carrying symptom, scope, the plan-section schema required by the repo's authoring protocol, the cite-`file:line` rule, and a per-agent entry point. Withhold any root-cause hypothesis.
3. Define the entry-point roster (failing behavior / tests and contracts / git history / architecture) as data, not hardcoded prose, so fleet size is configurable.
4. Add the fan-in dispatch: N terminals, same brief, distinct entry point and distinct output path each. Reuse the existing PTY prompt delivery rather than writing a second sender. Investigators are idle at dispatch time, so stdin delivery is correct here — this is the dispatch case, not the mid-flight coordination case.
5. Suppress cross-agent comms for the duration: a run-scoped standing-order override that turns off the team-inbox check, plus pointing each agent only at its own output path.
6. Add a brief-hygiene guard that fails the run when `brief.md` contains root-cause language. This is the durable half of the plan — the independence property is destroyed by prose, not by code, so the check has to live at the prose layer.
7. Add run completion detection: watch the run directory for the expected outputs, complete on quorum or deadline, and record which investigators contributed. Writes land via temp-file-plus-rename so no partial read is possible.
8. Emit a run manifest recording run id, brief path, roster, per-agent status and completion reason, so plan 02 has a typed input rather than having to infer the run's shape from directory contents.

## Proposed Changes

### Run directory + manifest (new)
- **Context:** No isolated location exists for draft plans; `.switchboard/plans/` is auto-imported.
- **Logic:** `.switchboard/planning-runs/<run-id>/` holding the brief, per-agent drafts and a manifest.
- **Edge Cases:** Must stay outside every plan-watcher glob; atomic writes; unbounded growth over many runs.

### Brief author + hygiene guard (new)
- **Context:** Nothing composes a shared problem statement for a fleet, and nothing stops it carrying a diagnosis.
- **Logic:** Emit the brief from the problem statement; fail the run if it asserts a root cause.
- **Edge Cases:** Over-eager guard rejecting a legitimate symptom description; the guard must key on causal claims, not on the presence of file paths.

### Fan-in dispatch path (new)
- **Context:** `triggerBatchAgentFromKanban` is 1 plan : 1 agent (`KanbanProvider.ts:5683`); the transpose does not exist.
- **Logic:** Dispatch N agents against one brief with per-agent entry point and output path.
- **Edge Cases:** Fewer live terminals than roster entries; an investigator dying mid-run; quorum vs all-N completion.

### Run-scoped comms suppression
- **Context:** Standing orders instruct agents to check a team inbox; correct in general, wrong during generation.
- **Logic:** Per-run override disabling the inbox check for phase 1.
- **Edge Cases:** Override leaking past the run and silently disabling comms for later work; integration site postdates this commit and must be located first.

## Verification Plan

1. A run with four investigators produces exactly four draft plans in `.switchboard/planning-runs/<run-id>/` and **zero** new cards on the kanban board — confirming the drafts are outside the watched tree.
2. Each draft is a complete plan against the repo's section schema, not a fragment or a partial investigation report.
3. The four drafts show substantive divergence on at least one claim when run against a problem with a known counterintuitive answer. Four near-identical drafts mean the entry points aren't producing independent trajectories and the roster needs work — this is the test that the design's core premise holds.
4. No draft references another investigator's findings or output path — the independence property, checked by inspection of all four.
5. The brief contains no root-cause assertion, and the hygiene guard fails a brief that has one injected deliberately.
6. Killing one investigator mid-run still completes the run on quorum, with the manifest recording which agent did not contribute.
7. A draft observed by the lead is never truncated — verified by reading the run directory under concurrent investigator writes.
8. `npx tsc --noEmit` introduces no new errors against the pre-existing baseline (5 errors at HEAD, unrelated).

## Recommendation

Complexity 5 → **Send to Coder**, after the two User Review decisions are settled. The dispatch mechanics are a transpose of an existing path; the real work is the run directory contract and the brief hygiene guard, which is where the independence property either holds or silently doesn't.
