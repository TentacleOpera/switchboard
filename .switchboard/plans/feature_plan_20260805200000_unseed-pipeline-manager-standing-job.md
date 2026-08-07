# Un-seed `pipeline-manager` — Keep the Declared-Moves Capability, Drop the Default Job

## Goal

Remove `pipeline-manager.md` from the standing-job files Switchboard seeds by default, keep the declared-intent moves machinery it exercises exactly as built, and document the pattern as an advanced opt-in the user authors themselves rather than a default Switchboard asserts is ready.

### Problem & background

**What seeding a job actually claims.** `seedDefaultStandingJobs` (`src/services/ScheduledJobsService.ts:360-426`) writes five job definitions into `.switchboard/instructions/standing/` on first use: `notes-to-plans`, `memo-to-plans`, `nightly-code-review`, `research-unknowns`, `pipeline-manager`. A file sitting in `standing/` is not a suggestion — the whole protocol is that a cron agent reads that directory and executes what it finds. Seeding a job is therefore a claim that the job is ready to run unattended, on the user's board, with nobody watching.

**Four of the five are authoring or review work. One is not.**

| Seeded job | Work product | Capability required of the external agent |
|---|---|---|
| `memo-to-plans` | plan files | read markdown, write markdown |
| `notes-to-plans` | plan files | read its own connected source, write markdown |
| `nightly-code-review` | findings appended to plan files | read markdown, write markdown |
| `research-unknowns` | rewritten `## Uncertain Assumptions` | dispatch own research, write markdown |
| **`pipeline-manager`** | **board column transitions** | **reason correctly about planIds, real column IDs, and a strict grammar** |

The first four read and write prose. `pipeline-manager` is the only one whose correctness depends on getting *identifiers and enumerations* right against a system it cannot query.

**Root cause of the concern — measured, not speculative.** Reviewing this feature's five coding passes established that the external surfaces in question fail in one specific way: they write the interface they expect rather than the one that exists. Concretely, in this very subsystem, a coding pass produced a hardcoded column set containing `'CODED'` — which is not a built-in column ID — while omitting `RESEARCHER`, `PLAN REVIEWED` and `TICKET UPDATER`, and separately passed a `planId` to a method keyed on `session_id`. The built-in IDs are `CREATED | RESEARCHER | PLAN REVIEWED | LEAD CODED | CODER CODED | INTERN CODED | CODE REVIEWED | ACCEPTANCE TESTED | TICKET UPDATER | COMPLETED`.

`pipeline-manager`'s output is a file of exactly those two things — a planId and a column ID per line. It is the one seeded job whose work product is made entirely of the values these surfaces get wrong. That is not a reason to delete the capability; it is a reason not to ship it switched on.

**The seeded body makes it worse than a bare capability.** Its current instruction reads *"Advance plans through workflow stages using subagents"* with no column vocabulary, no planId source named, and no scope limit. An agent following that has to invent both the identifiers and the set of cards in play. The strict grammar and whole-file rejection in the apply path (`processDeclaredMoves`) will refuse malformed files correctly — but a *well-formed* file naming a plausible-looking wrong column is exactly what a confabulating agent produces, and refusal is the best case. The failure the user actually feels is an overnight run that moves nothing and logs a wall of skips.

**Why the machinery stays.** The declared-intent moves path is correct, reviewed and tested: strict grammar, whole-file rejection on any malformed line, planId→sessionId resolution before the move, application through the human-click path, per-line outcome rows in `board_move_requests`, and a live watcher. Nothing about it is in question. The capability is sound; seeding a *default job* that leans on the weakest link in the chain is the part to withdraw. A user who writes their own job definition, with their own column vocabulary and their own scope, is a different risk profile from a file Switchboard put there.

---

## Metadata
**Complexity:** 3
**Tags:** backend, reliability, docs
**Project:** browser-switchboard

---

## User Review Required

**None.** Two decisions made here:

* **Un-seed, do not gate.** No setting, no feature flag, no "enable advanced jobs" toggle. A flag is a confirmation dialog with extra steps: it adds a code path, a persisted key and a migration for a capability the user can already have by writing one markdown file. Absence is the correct default state.
* **Keep the machinery and keep documenting the grammar.** The Spark artifact continues to publish the moves grammar so a user-authored job works. What changes is that Switchboard stops shipping a job that uses it.

---

## Complexity Audit
* **Score:** 3 / 10

### Routine
* Removing one entry from the `jobs` array in `seedDefaultStandingJobs`.
* Adding one imperative sentence to the Spark artifact's declared-moves grammar section (`SparkContextExporter.ts:221-227`).
* Removing one `<li>` element from the Connections panel HTML (`connections.html:474`).

### Complex / Risky
* **Seeding is write-if-absent, so code removal does not un-seed an existing file.** `seedDefaultStandingJobs` guards on `if (!fs.existsSync(p))` (`:422`). Anyone who has already triggered a bootstrap has `pipeline-manager.md` on disk, and removing it from the array leaves that file in place and still executable. Deciding what to do about the already-written file is the actual work in this plan, not the array edit.
* **Deleting a file in `standing/` is destructive if the user edited it.** The seed is a starting point; a user may have rewritten the body. Blind deletion would discard their work.
* **The moves apply path must not be touched.** It is easy to read "drop pipeline-manager" as "drop declared moves". Every part of §4 and §5 of the jobs plan stays.

---

## Edge-Case & Dependency Audit

### Race Conditions
* None. No new timers, watchers or concurrent writers. One-shot file handling during the existing bootstrap.

### Security
* None new. Strictly reduces what an unattended agent is told to do by default.

### Side Effects
* A user who was relying on the seeded `pipeline-manager` loses an unattended board-advancing job. That is the intent, and the replacement is documented rather than silent — see Proposed Changes §3 and §5.
* One fewer file in a freshly bootstrapped `standing/` directory.
* The Connections panel no longer lists `pipeline-manager.md` among the standing job definitions.

### Dependencies & Conflicts
* Seed function — `src/services/ScheduledJobsService.ts:360-426`, the entry at `:408-417`.
* Apply path that must remain untouched — `processDeclaredMoves` (`ScheduledJobsService.ts:144+`), its watcher (`KanbanProvider.ts:818-827`), the outcome rows (`recordBoardMoveRequest`), and the `board_move_requests` table.
* Spark artifact declared-moves grammar section — `src/services/SparkContextExporter.ts:221-227`. **Note:** `pipeline-manager` does not appear anywhere in this file (grep-confirmed); the change is additive (one sentence), not subtractive — see Proposed Changes §3.
* Connections panel standing-job list — `src/webview/connections.html:468-476`, the `pipeline-manager.md` entry at `:474`.
* Parent plan — *Scheduled External-Agent Jobs — Instruction Inbox and Standing Jobs*, whose §3 table lists `pipeline-manager` as one of the jobs to ship. This plan amends that decision; record the amendment in that plan rather than silently contradicting it.
* Contract suite — `src/test/scheduled-jobs-and-connections.test.js`, wired as `test:contract:scheduled-jobs`. Its declared-moves assertions must keep passing unchanged; that is the proof the machinery survived.

### Migration
* **Unreleased state — a clean break is permitted.** `ScheduledJobsService.ts` exists only in local, unreleased work on this feature (`git log --all` shows it first appearing in the current review cycle; shipped version is 1.7.13, which has no jobs subsystem). No released version ever seeded `pipeline-manager.md`, so there is no install base carrying it and no migration owed to the ~4,000 published installs.
* **Local dev workspaces are the only ones affected**, and they are handled by §2 below rather than by a migration.

---

## Dependencies
* None blocking.

---

## Adversarial Synthesis

Key risks: (1) **the array edit reads as complete when it is not** — seeding is write-if-absent, so removing the entry leaves every already-bootstrapped workspace with a live `pipeline-manager.md` that an agent will still execute; (2) **over-correction** — reading this plan as "remove declared moves" would tear out a correct, tested subsystem, and the Spark artifact would stop publishing a grammar a user-authored job needs; (3) **destroying user edits** — the seeded file may have been rewritten by hand, so unconditional deletion loses work; (4) **incomplete un-seeding across channels** — the Connections panel UI (`connections.html:474`) lists `pipeline-manager.md` as a shipped job, and the plan's original §3 misidentified the Spark artifact's structure (no enumerated job list exists to drop from — `pipeline-manager` appears nowhere in `SparkContextExporter.ts`). Mitigations: handle the already-written file explicitly and only when it is byte-identical to the seed we shipped; assert in a test that the moves apply path and its grammar are unchanged; leave the grammar in the artifact and add one sentence explaining that the job is user-authored; drop the UI listing in `connections.html` so all three channels (seed array, Spark artifact, Connections panel) agree.

---

## Proposed Changes

**Build order:** (1) un-seed → (2) retire the already-written file → (3) document the pattern in the Spark artifact → (4) drop the UI listing in connections.html → (5) amend the parent plan → (6) pin it with a test.

### 1. `src/services/ScheduledJobsService.ts` — remove the seed entry

**Implementation:** delete the `pipeline-manager.md` entry (`:408-417`) from the `jobs` array in `seedDefaultStandingJobs`. The remaining four stay exactly as they are.

**Logic:** the seed set becomes "jobs whose work product is markdown". That is a coherent line a future contributor can apply without re-litigating this decision, and it is worth stating as a comment above the array so the next person adding a job asks the right question.

**Edge cases:** do not reorder or reword the surviving four — they are unrelated to this change and reordering makes the diff unreadable.

### 2. Retire an already-written `pipeline-manager.md`, non-destructively

**Context:** `:422` guards on `!fs.existsSync(p)`, so a workspace bootstrapped before this change keeps the file and a cron agent keeps executing it. Code removal alone does not reach it.

**Implementation:** during `bootstrapInstructionsDirectory`, if `standing/pipeline-manager.md` exists **and its content is byte-identical to the seed body this codebase previously wrote**, rename it to `standing/pipeline-manager.md.retired` — a name the standing-job reader does not pick up. If the content differs in any way, leave it completely alone: the user edited it, it is theirs, and a job they wrote is exactly the opt-in this plan endorses.

**Logic:** byte-comparison is the only honest test of "this is our file, not theirs". A timestamp or a marker comment would be guessing. Rename rather than delete because the protocol elsewhere in this subsystem is deliberately non-destructive, and because a `.retired` file is self-explanatory to a user who finds it.

**Edge cases:** carry the exact previous seed body as a constant for the comparison; do not reconstruct it from the current array, which no longer contains it. If the rename fails (permissions, read-only mount), log and continue — bootstrap must never throw on this path. Retiring is idempotent: a second pass finds no `pipeline-manager.md` and does nothing.

### 3. `src/services/SparkContextExporter.ts` — document the pattern, keep the grammar

> **Superseded:** in the standing-job example list (`:133`), drop `pipeline-manager.md` from the enumerated examples. Keep the declared-moves grammar section exactly as it is. Add one sentence to the moves section stating that board-advancing jobs are **user-authored, not shipped**.
> **Reason:** `pipeline-manager` does not appear anywhere in `SparkContextExporter.ts` (grep-confirmed — zero matches). Line 133 is inside the AGENTS.md curation area (`curateAgentsMd`), not a standing-job example list. The standing-jobs section (lines 216-220) describes the frontmatter format generically and enumerates no job filenames. There is nothing to drop; the change is purely additive.
> **Replaced with:** in the declared-moves grammar section (`:221-227`), add one imperative sentence stating that board-advancing jobs are **user-authored, not shipped by Switchboard**, and that such a job must name its column IDs explicitly from the board's real vocabulary rather than inferring them. The grammar stays exactly as is — no subtraction needed.

**Implementation:** in the `### Declared Board Moves` section (`:221-227`), after the line about malformed lines rejecting the entire file (`:227`), add one imperative sentence: "Board-advancing jobs are **user-authored, not shipped by Switchboard**. A job that moves cards must name its column IDs explicitly from the board's real vocabulary (listed above) rather than inferring them." Do not modify the grammar, the column-ID list, or the frontmatter spec.

**Logic:** the artifact is the only channel by which an external agent learns anything about Switchboard. The grammar must stay so a user-authored job is possible; the added sentence makes it clear that Switchboard does not ship such a job, so the agent does not expect to find one in `standing/`.

**Edge cases:** this section is read by an unattended agent with nobody watching, so the added sentence must be imperative, not advisory.

### 4. `src/webview/connections.html` — drop the UI listing

**Context:** the Connections panel lists standing job definitions for the user at `:468-476`. The list includes `pipeline-manager.md` at `:474` with the description "Produces declared moves in `.switchboard/instructions/moves/`". A user reading this panel sees `pipeline-manager.md` presented as a shipped job — the exact impression this plan withdraws.

**Implementation:** remove the `<li>` for `pipeline-manager.md` at line 474. The remaining three entries (`memo-to-plans`, `nightly-code-review`, `research-unknowns`) stay. Do not add `notes-to-plans` — its absence from this list is a pre-existing issue unrelated to this plan's scope.

**Logic:** the UI is a second channel (after the seed array and the Spark artifact) that tells a user "Switchboard ships this job." All three channels must agree, or the un-seeding is incomplete in the user's perception even when the code is correct.

**Edge cases:** none. A static HTML list edit with no logic.

### 5. Amend the parent plan

**Implementation:** in *Scheduled External-Agent Jobs — Instruction Inbox and Standing Jobs*, add a `> **Superseded:**` block over the §3 row that lists `pipeline-manager` among the jobs to ship, recording that the machinery stays and the seeded job is withdrawn, with the reason. Do not delete the row — the reasoning behind it is still the reasoning for keeping the capability.

**Logic:** that plan's table is what a future contributor reads to decide whether the job set is complete. An unexplained absence invites someone to "fix" it by re-adding the job.

### 6. Test

**Implementation:** extend `src/test/scheduled-jobs-and-connections.test.js`:
* a fresh bootstrap seeds exactly the four markdown-producing jobs and **no** `pipeline-manager.md`;
* a workspace containing a byte-identical `pipeline-manager.md` has it renamed to `.retired` on bootstrap;
* a workspace containing a **modified** `pipeline-manager.md` keeps it untouched;
* the existing declared-moves assertions still pass — this is the proof the machinery was not collateral damage.

**Logic:** the second and third cases are the ones that cannot be verified by reading the diff, and the fourth is what distinguishes this change from an over-correction.

---

## Verification Plan

### Automated Tests

> **Session directive: compilation and automated tests are SKIP.** The items below are the target coverage for the coding pass when tests are run; they are not executed as part of this planning session.

* `npm run test:contract:scheduled-jobs` — the four new assertions plus every existing one, especially the declared-moves group, which must pass **unchanged**.
* `npx tsc -p tsconfig.test.json --noEmit`; `npm run lint`.
* All six gates: `catalog:check`, `parity:check`, `push-routing:check`, `verb-returns:check`, `mirror:check`, `icons:parity`. No verb, route or arm changes here, so any movement in a ratchet means something was touched that should not have been.

### Manual Verification
1. **Fresh workspace:** trigger a bootstrap; `standing/` contains four files and no `pipeline-manager.md`.
2. **Pre-existing untouched file:** place the exact previous seed body at `standing/pipeline-manager.md`, bootstrap, confirm it is renamed to `.retired` and that a standing-job reader no longer picks it up.
3. **Pre-existing edited file:** modify one character of that body, bootstrap, confirm it is left exactly as-is.
4. **Machinery intact:** drop a hand-written moves file with one valid and one invalid line; the valid move still applies through the human-click path and the invalid line is still recorded as skipped with a reason.
5. **Artifact reads correctly:** regenerate `switchboard-spark.md`, read the standing-jobs and moves sections as the receiving agent would, and confirm the grammar is present, the "user-authored, not shipped" sentence is present, and no shipped board-advancing job is implied.
6. **Connections panel:** open the Connections panel in the browser/extension; the Standing Job Definitions list shows three entries (`memo-to-plans`, `nightly-code-review`, `research-unknowns`) and no `pipeline-manager.md`.
7. **Plan import:** confirm the importer registers this plan on the board.

---

## Recommendation

Complexity 3 → **Send to Coder.**

## Completion Summary

Removed `pipeline-manager.md` from `seedDefaultStandingJobs` in `src/services/ScheduledJobsService.ts`, added a byte-exact `LEGACY_PIPELINE_MANAGER_BODY` constant, and updated `bootstrapInstructionsDirectory` to rename an unmodified legacy `pipeline-manager.md` to `pipeline-manager.md.retired` while leaving user-edited versions untouched. Added an imperative sentence to `src/services/SparkContextExporter.ts` clarifying that board-advancing jobs are user-authored, not shipped by Switchboard. Dropped the `pipeline-manager.md` list item from `src/webview/connections.html`. Added a superseded block to the parent `feature_plan_20260805130001_scheduled-external-agent-jobs-instruction-inbox.md` plan. Extended `src/test/scheduled-jobs-and-connections.test.js` to assert the four-seed set, the retirement behavior, and the preservation of modified files. No issues were encountered; compilation and test runs were skipped per the session directive.

## Review Findings

**Reviewer pass:** all six plan requirements verified against the actual code. Files changed: `src/services/ScheduledJobsService.ts` (seed entry removed, `LEGACY_PIPELINE_MANAGER_BODY` constant + `retireLegacyPipelineManager` added and wired into bootstrap), `src/services/SparkContextExporter.ts:228` (imperative "user-authored, not shipped" sentence added, grammar preserved), `src/webview/connections.html:471-473` (pipeline-manager `<li>` dropped, 3 entries remain), `src/test/scheduled-jobs-and-connections.test.js` (4 new assertions + existing declared-moves group unchanged), parent plan `feature_plan_20260805130001` (Superseded block at line 181). The `LEGACY_PIPELINE_MANAGER_BODY` constant matches the original seeded body byte-for-byte (verified against git commit `1c7de0f6`). The `.retired` extension correctly hides the file from any `.md`-filtering reader. No orphaned `pipeline-manager` references in production code — all remaining occurrences are intentional (legacy constant, retire function, tests). No CRITICAL or MAJOR findings; one NIT (LEGACY constant duplicated between production and test — acceptable as a frozen historical artifact). Verification: `test:contract:scheduled-jobs` 22/22 passed, `tsc --noEmit` clean, `lint` 0 errors, all 6 gates (`catalog:check`, `parity:check`, `push-routing:check`, `verb-returns:check`, `mirror:check`, `icons:parity`) green and CI-wired in `.github/workflows/integration-tests.yml`. Remaining risk: none material — the moves apply path (`processDeclaredMoves`) is untouched and its tests pass unchanged.
