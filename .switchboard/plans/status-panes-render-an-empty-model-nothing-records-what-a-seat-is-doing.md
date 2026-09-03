# Status panes render an empty model — nothing records what a seat is working on

<!-- board-collapse-07b -->
> **SCHEMA DEPENDENCY 2026-09-04 (Board Collapse 07).** This plan reads or writes columns that *Split the schema into shared board state and machine-local runtime* **relocates**: `dispatched_terminal`, `dispatched_at`, `last_liveness_at`, `blocked_at` and the `worktrees` table move out of `plans` into separate machine-local runtime tables keyed by `plan_id` + `device_id`, in a different database file that never travels to a remote store. Whichever lands second must target the schema that then exists. The tier split is step 6 of the storage programme (see the *Storage layer overhaul* feature file), so in practice this plan lands first — but do not assume it: check where those columns live before writing the query.


## Goal

Make a status pane able to answer "what is this seat doing?" A coder that is actively working must not render identically to one that is idle. Both inputs the pane already reads — the seat's assigned plan and its team reports — must actually be populated.

### Problem Analysis

Status mode shipped 2026-09-03 (`a870fa8e`), promising *"nine cramped 40-column viewports become one live terminal and eight readable facts."* Operator report the same day: the status screens never show anything, so coders look idle even while working. The expectation was a line like *"subtask name, dispatched by lead."*

**The pane is not broken.** `renderStatusPane` (`terminals.js:7518`) renders identity, exit state, a head crown, role — and `state.planTitle` when there is one. `refreshSeatReports` (`:7368`) fetches `GET /teams/{id}/reports` per spawned team and parses reports of kind `finished | blocked | question | status` (`:7311`). Both surfaces exist and both are wired.

**Both inputs are empty.** Measured 2026-09-03 against a team of four actively working seats:

| seat | role | planId | planTitle |
| :-- | :-- | :-- | :-- |
| `Coding` | lead | null | null |
| `Coding-coder-1` | coder | null | null |
| `Coding-coder-2` | coder | null | null |
| `Coding-intern` | intern | null | null |

And `.switchboard/teams/*/reports/` **does not exist** — the inbox the pane reads has never been written to.

So the pane is faithfully displaying an accurate model. The model is that nothing is happening. Three coders were mid-task at the time of measurement.

**Cause one: work is delivered as text, so no association is recorded.** The lead dispatches subtasks with `POST /terminals/verb/ptySendPrompt`, carrying the plan content as prompt data. That writes bytes to a pty. It stamps no `dispatched_terminal` on any card, creates no holder, and leaves the board with no way to know which seat has which plan. `planTitle` is therefore null for every seat, and the pane has nothing to name.

This is not only a display problem. The same missing association is why seat-release defects keep recurring: `A column move orphans the dispatch holder` (`bf23c37f`) and `A queued card has no holder; only completed_at releases a team` (`0023bf40`) are both about a card whose holder is wrong or absent. A card dispatched by prompt injection has no holder from the start.

**Cause two: nothing writes seat reports.** The four report kinds are the richer half of what the operator expected — a seat announcing it finished, is blocked, or has a question. No seat has ever written one. Either no agent instruction tells them to, or the write path is unreachable from a seat; this plan must establish which before specifying the fix.

**Why leads still hand-roll HTTP.** `Agent skills reach the API through the CLI` (`6fc37578`, PLAN REVIEWED, c6) and its subtask `switchboard api` (`8aa2e928`, PLAN REVIEWED, c3) exist precisely to retire this pattern, and neither has been coded. **Four files under `.agents/protocols/` and `.agents/skills/` still contain `curl -s -X POST`.** A lead following its own instructions writes curl, so the board-aware path is not the one in front of it. That feature is the prerequisite for making the fix stick rather than a parallel effort.

### Root Cause

Seat activity is modelled in two places that only a board-mediated dispatch populates, and the dispatch path agents are actually instructed to use bypasses both. The status pane was built against the model rather than against what the model contains, so a feature that reads correctly from an empty source looks broken while being right.

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, teams, ux, agent-instructions
**Project:** Browser Switchboard

## Proposed Changes

**1. Record the association even when work arrives as a prompt.** When `ptySendPrompt` carries a plan — the payload already travels with an `origin` and the lead knows the `planId` — stamp `dispatched_terminal` for that card. A seat given work must have a holder, whatever route the work took. This is the change that lights up `planTitle` on every pane and gives the release paths something true to act on.

**2. Establish why no seat report has ever been written**, then fix the cause rather than the symptom. Check in order: whether any agent instruction names the report path; whether a seat can reach `POST /teams/{id}/reports` (or whatever the write route is) from its sandbox; and whether the directory is created lazily on first write or expected to pre-exist. Do not add a writer until it is known which of these is missing.

**3. Say "working, no report yet" rather than nothing.** Even with both inputs empty, a pane can distinguish a seat that is producing output from one that is silent — `lastDataAt` is already on the fleet payload. A seat with recent output and no plan should read as active-but-unattributed, not idle. This is the smallest change and the one that stops the pane lying today.

**4. Depends on `6fc37578`.** Retiring curl from agent instructions is what makes change #1 durable: while four protocol files still demonstrate raw HTTP, a lead will keep choosing the path that records nothing. Land the CLI surface first, or land these together.

### Not in scope

Changing what a status pane looks like, or the `live`/`status` toggle gesture. The presentation is fine; this plan is about what it has to show.

## Verification Plan

1. A lead dispatches a subtask to a coder. `fleet --json` reports a non-null `planId` and `planTitle` for that seat, and the status pane names the plan.
2. The same holds when the work is delivered via `ptySendPrompt` rather than a board dispatch.
3. Completing that card releases the seat, and the pane stops naming the plan — verified against `0023bf40` and `bf23c37f` not regressing.
4. A seat writing a `finished` / `blocked` / `question` / `status` report has it appear in its team's pane within one refresh.
5. A seat producing output with no plan association renders as active, not idle.
6. A genuinely idle seat still renders as idle — the change must not make everything look busy.
7. No agent-facing protocol or skill file instructs a raw `curl` against the API (asserted with `6fc37578`).
