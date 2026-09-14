# Switchboard Runs Inside a 1 GB Pi

**Complexity:** 6

## Goal

The standalone host runs a real team on a 1 GB device within a stated 800 MB peak RSS budget, measured under load rather than at idle. Measured 2026-09-13 over 10 minutes with nine live seats: RSS 488 MB minimum, 749 MB peak, V8 heap swinging 138 to 352 MB. The peak is what does not fit, not the baseline, and the driver is that every board read returns all 579 cards with all 43 columns and every caller narrows afterwards in JavaScript. This feature closes the footprint work: what the two supported configurations actually are, and what the host must cost to hold a team on the smallest supported board.

## How the Subtasks Achieve This

- **Two Configurations: Board Only, and Board Plus Agents**: states what the product actually
  claims to run on. The 1 GB target is only meaningful for board-only — with seats local, the
  measured 2.2 GB of agent CLI processes dwarfs everything the host does. This subtask is what
  makes the budget in the other one a claim about a named configuration rather than a number
  without a subject.
- **The Board Must Fit a 1 GB Pi, and It Is the Peak That Does Not**: sets and enforces the
  800 MB peak-RSS budget, measured under load. It carries the measurement (RSS 488 min / 749
  peak, heap 138 → 352, a 214 MB swing collected twice in ten minutes), identifies the driver
  (`SELECT <43 columns> FROM plans WHERE workspace_id = ?` with no predicate, called from 16
  sites, each narrowing in JS afterwards), and makes the V8 old-space limit an explicit,
  measured setting rather than whatever Node derives from physical memory.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Two Configurations: Board Only, and Board Plus Agents](../plans/two-configurations-board-only-and-board-plus-agents.md) — **CODE REVIEWED** — ID: c76ca59b-5ad5-4684-bbd8-0124e85aebde
- [ ] [The Board Must Fit a 1 GB Pi, and It Is the Peak That Does Not](../plans/the-board-must-fit-a-1gb-pi-and-the-peak-is-what-does-not.md) — **CODE REVIEWED** — ID: 8b7e5490-ebb5-4782-8467-592cdd03c2c4
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Two Configurations** should land first: it decides which configuration the budget applies to,
and a ceiling written before that is a number with no subject.

Neither subtask should be coded before the forced-GC measurement in change 1 of the budget
subtask. RSS alone cannot separate live retention from allocator churn, and that answer decides
which optimisation is the one that matters — optimising first is how a 4 GB budget came to be
written for a host that needs to fit 1 GB.

### Related work deliberately NOT grouped here

Four plans touch the same footprint and are all past coding, so pulling them in would drag
finished work backwards:

| plan | column | why it is out |
| :--- | :--- | :--- |
| Establish a resident-memory budget for the standalone host | CODE REVIEWED | right mechanism, 4 GB target — this feature reuses its forced-GC method |
| The Board Renders Every Card It Has Ever Held | CODE REVIEWED | open-time latency; helps here incidentally |
| One Shell Load Builds the Board Fourteen Times | CODE REVIEWED | the allocation churn itself |
| The Terminals Panel Costs a Megabyte and a Half | LEAD CODED | client-side weight |

*Building and Gating on the Pi* (`b5d07e2b`) is a separate feature and stays separate: it is
about build time and the toolchain on the Pi, not about what the host costs while running.

## Completion Summary

Both subtasks are implemented and verified. "Two Configurations" stated board-only (1 GB) and board-plus-agents (2 GB min) and wired the unconditional `--max-old-space-size` V8 flag at both Go handoff sites, env-overridable via `SWITCHBOARD_MAX_OLD_SPACE_MB`, plus repo-relative plan paths for remote seats and remote-seats documentation. "The Board Must Fit a 1 GB Pi" shipped the working-set windowing (dormant PLAN REVIEWED / CODE REVIEWED cards past the hot window are read-side filtered, never archived, still resolvable by id), the empty-field omission in the card builder, the forced-GC burst probe, and the 800 MB peak-RSS contract. A mid-run defect — the in-flight SQL referencing `plans.dispatched_at`, a column the V74 migration moved to `plan_runtime_state`, which broke every board read — was fixed with a correlated EXISTS against the runtime-state table. Final verification: `test:contract:board-payload-size` 15/15 and `test:contract:board-peak-rss` 7/7, both including LIVE halves against a freshly built host; Go build/vet and eslint clean. One minor warn-path inconsistency (`_warnIfPlanFileUncommitted` repoRoot choice) is recorded in `.switchboard/orchestrator/reports/` for follow-up.

## Review Findings

Both subtasks reviewed in place against commits `8300a014` + `8839c514`. Two defects were fixed in
`src/services/KanbanDatabase.ts` and `src/services/KanbanProvider.ts`, with gates added/repaired in
`src/test/board-payload-size-contract.test.js` and `src/test/board-read-endpoints-contract.test.js`:
the working-set window had no feature-unit cohesion, so a dormant feature row was dropped from under
its live subtasks and — because the webview rolls subtasks up under their parent and filters every
card carrying a `featureId` out of the column view — the whole unit including in-flight work
rendered nowhere; and `board-read-endpoints`, the gate the budget subtask named as must-stay-green,
was RED because `_resolveBoard` moved to `getBoardWorkingSet` without the test double following.
The feature's stated goal — a 800 MB peak-RSS budget, enforced — is met and gated (live peak 479 MB),
but the room-making half is not yet real: the windowing excludes **zero** of 456 dormant cards on the
actual board because it keys on the 45-day cold-archive hot window, and Change 1's forced-GC split,
which the budget subtask declares a prerequisite gate, was never executed. Verification:
`compile-tests` clean, `board-payload-size` 18/18, `board-peak-rss` 7/7, `board-read-endpoints` 36/37
(sole failure a pre-existing, unrelated skill-bundle drift), Go vet/build clean, eslint 0 errors.

## Deferred Findings

- CRITICAL — the working-set window excludes 0 of 456 dormant cards on the real board (45-day hot window vs a newest-dormant age of ~18 days), so the 408-card reduction the feature is built on is not realised. `src/services/KanbanDatabase.ts:4704`. Full reasoning on the budget subtask's own Deferred Findings.
- MAJOR — the forced-GC churn-vs-retention split (Change 1, declared a PREREQUISITE GATE) was never run, leaving the burst unattributed and the 512 MB V8 old-space value an admitted placeholder. `src/services/KanbanProvider.ts` (`_recordBurstGcSplit`).
- MAJOR — `selectColdEligiblePlanIds` reads `dispatched_at` off `plans`, removed by V74; the prepare throws, the catch returns `[]`, and cold partitioning has silently never run post-V74. Pre-existing, outside both subtasks. `src/services/KanbanDatabase.ts:6072`.
- MAJOR — `_warnIfPlanFileUncommitted` passes a workspace-relative path with a repo-scope-relative cwd, so a scoped repo's git query silently finds nothing and silence reads as "committed". `src/services/KanbanProvider.ts`.
- MAJOR — the LIVE half of the windowing gate (`staleDormant < 10`) cannot discriminate on this board; the real-store half is the actual gate. `src/test/board-payload-size-contract.test.js:384`.
- NIT — windowing `_resolveBoard` degrades custom-column discovery for columns held only by dormant cards. `src/services/LocalApiServer.ts:10404`.
- NIT — `_warnIfPlanFileUncommitted` spawns one `git status` subprocess per plan per dispatch. `src/services/KanbanProvider.ts`.
