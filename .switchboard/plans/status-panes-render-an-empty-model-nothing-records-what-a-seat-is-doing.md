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

## User Review Required

None. The status pane already renders a model; this plan populates the model the pane was built to read.

## Complexity Audit

### Routine

- Rendering "working, no report yet" from `lastDataAt` (already on the fleet payload) — a presentation change in `renderStatusPane`.
- The seat-report investigation (change #2): reading agent instructions, checking `POST /teams/{id}/reports` reachability from a seat sandbox, checking whether the reports directory is created lazily on first write.

### Complex / Risky

- **`dispatched_at` must be stamped alongside `dispatched_terminal`.** Change #1 stamps `dispatched_terminal` at `ptySendPrompt` but is silent on `dispatched_at`. The in-flight predicate (`heldByTeam`) reads `dispatched_terminal`, so the card counts as in flight — intended. But the activity light (`dispatched_at`) is what *A column move orphans the dispatch holder* (subtask 4) uses for its "live card first" ordering; a prompt-dispatched card with `dispatched_terminal` set and `dispatched_at` NULL is indistinguishable from the 569-row orphans subtask 4 is curing. Stamping `dispatched_at` too keeps the card "live"; the column-move writers and the completion post clear it as they already do for board-mediated dispatches. See the Clarification on change #1.
- **Change #2 is an undetermined investigation.** "Establish why no seat report has ever been written, then fix the cause" — the fix cannot be sized until the investigation runs. The plan is honest about this; keep it as a prerequisite investigation, do not fake a fix.
- **The 6fc37578 dependency is on an unreleased feature.** The CLI surface that retires curl from agent instructions is PLAN REVIEWED, not coded. Without it, leads keep using curl, and change #1 lights up `planTitle` only for board-mediated dispatches, not for curl-dispatched prompts. See Dependencies for the degradation.
- **The storage-overhaul schema dependency.** The SCHEMA DEPENDENCY note (top) says `dispatched_terminal`, `dispatched_at`, `last_liveness_at`, `blocked_at` and the `worktrees` table move to machine-local runtime tables. Change #1's stamp target may move before this lands; check where those columns live before writing the query.
- **Both hosts.** `ptySendPrompt` is handled in both composition roots; the stamp must land in the shared path, not one root.

## Edge-Case & Dependency Audit

**Race conditions**

- A `ptySendPrompt` stamp racing with a column move that nulls `dispatched_at`: the stamp sets `dispatched_terminal` + `dispatched_at`; the column move nulls `dispatched_at` but keeps `dispatched_terminal` (per subtask 4's table). The card stays held (correct) and the activity light clears (correct). The stamp should only fire on a fresh dispatch, not a re-prompt, or a re-prompt re-sets `dispatched_at` on a moved card and reads as "working now" in a post-dispatch column.

**Security**

- No new surface. The stamp is driven by the dispatch payload's `origin`/`planId`, not caller input.

**Side effects**

- Stamping `dispatched_terminal` on every prompt-dispatched card makes more cards count as in flight (`heldByTeam`). A team with a prompt-dispatched card now blocks the queue until the seat posts. Intended — a seat given work should hold.
- "working, no report yet" changes the pane's idle-vs-active rendering — intended; a genuinely idle seat must still render as idle (Verification 6).

**Dependencies & conflicts**

- 6fc37578 (Agent skills reach the API through the CLI) + its subtask `switchboard api` (8aa2e928) — unreleased (PLAN REVIEWED). Change #1's durability depends on retiring curl from agent instructions; without it, curl-dispatched prompts never stamp.
- Storage overhaul (Split the schema into shared board state and machine-local runtime) — relocates the columns change #1 stamps; check the schema before writing the query.
- *A column move orphans the dispatch holder* (subtask 4) — owns the release path that keys on `dispatched_terminal`; change #1's stamp feeds it. Compatible.
- *The lead's acceptance post silently releases nothing* (subtask 2) — its `cleared: false` board surface should land on the seat-status field this plan populates; coupling noted in subtask 2.

## Dependencies

- **6fc37578** (Agent skills reach the API through the CLI) + subtask `switchboard api` (8aa2e928) — unreleased (PLAN REVIEWED). Change #1's durability depends on retiring curl from agent instructions. **Degradation without it:** change #1 lights up `planTitle` only for board-mediated dispatches; curl-dispatched prompts remain unattributed. Land the CLI surface first, or land these together.
- **Storage overhaul** (Split the schema into shared board state and machine-local runtime) — relocates `dispatched_terminal`, `dispatched_at`, `last_liveness_at`, `blocked_at` and the `worktrees` table. Whichever lands second must target the schema that then exists. In practice this plan likely lands first, but do not assume it — check where those columns live before writing the query.
- *A column move orphans the dispatch holder* (subtask 4) — the release path that consumes the holder change #1 stamps; compatible, and change #1 feeds it.

## Adversarial Synthesis

Key risks: (1) change #1 stamps `dispatched_terminal` but is silent on `dispatched_at` — a prompt-dispatched card with a holder but no heartbeat is indistinguishable from the 569-row orphans subtask 4 is fixing (creating new orphans while curing old ones); (2) change #2 is an undetermined investigation — the fix cannot be sized until it runs; (3) change #1's durability depends on 6fc37578 (unreleased) and its stamp target may move under the storage overhaul. Mitigations: stamp `dispatched_at` alongside `dispatched_terminal`; keep change #2 as a prerequisite investigation; state the 6fc37578 degradation and check the storage schema before writing the query.

## Proposed Changes

**1. Record the association even when work arrives as a prompt.** When `ptySendPrompt` carries a plan — the payload already travels with an `origin` and the lead knows the `planId` — stamp `dispatched_terminal` for that card. A seat given work must have a holder, whatever route the work took. This is the change that lights up `planTitle` on every pane and gives the release paths something true to act on.

   **Clarification (`dispatched_at`):** stamp `dispatched_at` alongside `dispatched_terminal` on a fresh dispatch (not a re-prompt). The in-flight predicate (`heldByTeam`) reads `dispatched_terminal`, so the card counts as in flight either way — but the activity light (`dispatched_at`) is what *A column move orphans the dispatch holder* (subtask 4) uses for its "live card first" ordering. A prompt-dispatched card with `dispatched_terminal` set and `dispatched_at` NULL is indistinguishable from the 569-row orphans subtask 4 is curing. Stamping `dispatched_at` keeps the card "live"; the existing column-move writers (`KanbanDatabase.ts`) and the completion post clear it as they already do for board-mediated dispatches. Fire the stamp on a fresh dispatch only — a re-prompt must not re-set `dispatched_at` on a card whose column has already advanced.

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

### Goal Invariants

- **Positive:** after a `ptySendPrompt` carrying a plan, `fleet --json` reports a non-null `planId` and `planTitle` for that seat, and the status pane names the plan.
- **Positive:** the same holds when work is delivered via `ptySendPrompt` (not just a board dispatch).
- **Negative (paired):** a seat producing output with no plan association renders as active (`lastDataAt` recent), NOT idle. Paired positive: a genuinely idle seat (no recent `lastDataAt`, no plan) renders as idle.
- **Positive:** completing the card releases the seat and the pane stops naming the plan (no regression against `0023bf40` / `bf23c37f`).
- **Negative:** stamping `dispatched_terminal` on a prompt-dispatched card does NOT create a new orphan — `dispatched_at` is also stamped, so the card is "live" (not indistinguishable from a 569-row orphan). Paired positive: the column-move writers and the completion post clear `dispatched_at` as they do for board-mediated dispatches.
