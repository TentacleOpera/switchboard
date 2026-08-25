# Delete the head-prompt compat machinery for an unreleased surface

## Goal

Remove the fifteen frozen prompt snapshots, nine recognisers, and their arms in
`migrateAgentGroups` that migrate persisted team groups across revisions of a feature that
has never been released. Keep the one migration that repairs a persisted structural field.

### Problem Analysis

`src/services/teamWiring.ts` carries fifteen `OLD_` / `PRE_` / `CURRENT_BUGGY_` prompt
constants and nine `isUntouched*` recognisers, feeding a 252-line `migrateAgentGroups`
(`:1119-1370`). `src/webview/terminals.js` mirrors the pair at `:11035` / `:11050` and
applies its own migration at `:11321`.

Every one of them exists to rewrite a persisted `headPrompt` on installs carrying an
earlier revision of the spawned-teams feature. Spawned teams have never shipped in a
released version, so the only disks holding those values are dev machines, and the accepted
handling for unreleased state is a clean break: recreate the team, get the new prompt.

The cost of leaving them is not the lines. It is that the file reads exactly like a
heavily-migrated shipped surface, so a reader takes the machinery as proof the surface is
released and adds a sixteenth snapshot rather than editing the live text. That has already
happened once during review of this work.

**What must survive.** `migrateAgentGroups` itself stays. So does the `teamGroup: true`
flag migration at `:508` and `isUntouchedOldSeed` / `isUntouchedSeed` — those repair a
persisted *structural* field and neutralise the old three-coder seed, not prompt text, and
the seed predates the team feature.

## Metadata

**Tags:** backend, refactor, agents

**Complexity:** 4

## User Review Required

None. The clean-break rule for unreleased state settles it, and the structural seed
migration is explicitly retained.

## Complexity Audit

### Routine

- Deleting constants and functions nothing else calls.

### Complex / Risky

- Separating the prompt-text migrations (delete) from the structural seed and
  `teamGroup` flag migrations (keep) inside one 252-line function.
- `stage-marker-commit-contract.test.js` and `standing-orders-marker-contract.test.js`
  pin these constants, and BOTH ARE RED AT HEAD for unrelated reasons. Record their
  pre-change failure output before editing, or a newly introduced failure is
  indistinguishable from the existing one.
- The client mirror and its migration must be removed in the same change, or the browser
  keeps rewriting prompts the extension no longer recognises.

## Edge-Case & Dependency Audit

### Race Conditions

None. Startup-time migration code with no concurrent reader.

### Security

None. No endpoint, payload, or persisted authority is touched.

### Side Effects

- A dev install with a persisted group carrying an old prompt keeps it until the team is
  recreated. That is the clean break, taken deliberately.
- `migrateAgentGroups` gets substantially shorter, which changes its structure — the
  retained arms must be re-verified, not assumed.

### Dependencies & Conflicts

- Touches `teamWiring.ts` and `terminals.js` — the SAME files as the reviewer-removal
  subtask. It must follow that subtask; the two cannot run concurrently.
- Nothing in the release-contract subtask depends on this.

## Dependencies

- `the-coding-team-has-no-reviewer-seat.md` — same files; sequence after it.

## Adversarial Synthesis

Key risks: (1) deleting one arm too many and taking the structural seed migration with the
prompt ones, silently reviving the three-coder seed; (2) missing `BUGGY_HEADPROMPT_FRAGMENT`
because it doesn't match the `OLD_`/`PRE_`/`CURRENT_BUGGY_` naming pattern; (3) missing the
fragment-based arms in `migrateCodingTeamOrders` (a different function from
`migrateAgentGroups`); (4) under-scoping the terminals.js deletion (it's not just
`OLD_CODING_HEAD_PROMPT_CLIENT` and one line — it's six fragment constants, a marker, and
two matching blocks); (5) accidentally deleting `PRE_REWRITE_CALLBACK_INSTRUCTION` /
`migrateTeamPairOrders` (structural, not prompt-text). Mitigations: the retained set is
named explicitly and tested; all deletion targets are enumerated by name and line range;
`PRE_REWRITE_CALLBACK_INSTRUCTION` is called out as retained with its reason.

## Proposed Changes

### 1. `src/services/teamWiring.ts` — delete the prompt-text migration set

Remove the fifteen frozen prompt and fragment constants:
- Nine full prompt constants: `OLD_CODING_HEAD_PROMPT`, `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT`,
  `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT`, `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT`,
  `OLD_REVIEW_TEAM_HEAD_PROMPT`, `PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT`,
  `PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT`, `PRE_TRIAGE_REVIEW_HEAD_PROMPT`,
  `CURRENT_BUGGY_CODING_HEAD_PROMPT`.
- Six fragment constants: `OLD_HEADPROMPT_FRAGMENT`, **`BUGGY_HEADPROMPT_FRAGMENT`**
  (does NOT match the `OLD_`/`PRE_`/`CURRENT_BUGGY_` pattern — name it explicitly),
  `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT`, `PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT`,
  `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT`, `PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT`.
- `COMMIT_INSTRUCTION_MARKER` — dead code after the migration arms are deleted (it was
  only used as a gate in the fragment matching). Delete it and update any tests that
  reference it.

Remove the nine `isUntouched*` prompt recognisers (`:1497-1637`) and their arms inside
`migrateAgentGroups` (`:1119-1370`). Also remove the inline `OLD_REVIEW_TEAM_HEAD_PROMPT`
check at `:1248` (the ninth recogniser — not a named function but an inline match).

Remove the fragment-based matching arms inside **`migrateCodingTeamOrders`** (`:2613`) —
the `team-head` block at `:2677-2719` that uses `indexOf` on the six fragment constants,
and the `PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT` block at `:2640-2661`. These are in a
DIFFERENT function from `migrateAgentGroups` — both must be cleaned.

Retain: `migrateAgentGroups` (the function itself, minus the deleted arms), the
`teamGroup: true` flag migration (`:508`), `isUntouchedOldSeed`, `isUntouchedSeed`, and
`OLD_SEEDED_AGENT_GROUP`. Also retain **`PRE_REWRITE_CALLBACK_INSTRUCTION`** and
**`migrateTeamPairOrders`** (`:2414`) — these are STRUCTURAL migrations (converting old
pair-order rows into team-scoped orders), not prompt-text migrations. A coder might delete
`PRE_REWRITE_CALLBACK_INSTRUCTION` because it starts with `PRE_` and looks like a prompt
constant — it is not. It is the recogniser for the pair-order shape migration and must
survive.

### 2. `src/webview/terminals.js` — delete the client mirror and migration

Remove `OLD_CODING_HEAD_PROMPT_CLIENT` (`:11035`). Remove the six mirrored fragment
constants at `:11199-11247` (`OLD_HEADPROMPT_FRAGMENT`, `BUGGY_HEADPROMPT_FRAGMENT`,
`PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT`, `PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT`,
`PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT`, `PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT`) and
`COMMIT_INSTRUCTION_MARKER` (`:11230`). Remove the `PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT`
matching block at `:11284-11293` and the `team-head` fragment matching block at
`:11310-11352` — these mirror `migrateCodingTeamOrders` and are the client-side migration
arms. Keep the live prompt copy (`NEW_CODING_HEAD_PROMPT_CLIENT` at `:11050`). Keep the
`PRE_REWRITE_CALLBACK_INSTRUCTION` mirror (`:11006`) and the pair-order migration
(`:11099`) — structural, same as the host side.

### 3. Tests

Update `stage-marker-commit-contract.test.js` and `standing-orders-marker-contract.test.js`
to stop asserting on the deleted constants. Add an assertion that the structural seed
migration and the `teamGroup` flag migration survive.

## Verification Plan

### Automated Tests

- `stage-marker-commit`, `standing-orders-marker` — compare against their recorded
  pre-change failure output; no NEW failure.
- `team-scoped-routing`, `review-team-triage` — same treatment; both also red at HEAD.
- A new assertion that `isUntouchedSeed` still neutralises the old three-coder seed.

### Goal Invariants

- No `OLD_` / `PRE_` / `CURRENT_BUGGY_` prompt constant remains in `teamWiring.ts`.
- `BUGGY_HEADPROMPT_FRAGMENT` is absent from `teamWiring.ts` (it does not match the naming pattern).
- `COMMIT_INSTRUCTION_MARKER` is absent from both `teamWiring.ts` and `terminals.js`.
- No fragment-based matching arm remains in `migrateCodingTeamOrders` (`teamWiring.ts`).
- No fragment-based matching arm remains in the terminals.js migration block.
- `migrateAgentGroups` still neutralises the old three-coder seed.
- The `teamGroup: true` flag migration still runs.
- `PRE_REWRITE_CALLBACK_INSTRUCTION` and `migrateTeamPairOrders` survive (structural migration).
- `terminals.js` holds one prompt copy and no prompt-text migration.

### Manual Verification

1. Open the Agents tab on a dev install with a persisted old team: no prompt rewrite
   occurs, no error, the team is startable.
2. An install carrying the old three-coder seed still has it neutralised — starting a lead
   spawns a lead, not three coders.

## Recommendation

Send to Coder, after the reviewer-removal subtask. Droppable: cutting it costs only that
the next reader repeats the inference this subtask exists to prevent.

## Implementation Summary

Deleted all fifteen frozen head prompt text snapshots, fragments, and gate markers (`OLD_CODING_HEAD_PROMPT`, `PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT`, `PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT`, `PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT`, `OLD_REVIEW_TEAM_HEAD_PROMPT`, `PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT`, `PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT`, `PRE_TRIAGE_REVIEW_HEAD_PROMPT`, `CURRENT_BUGGY_CODING_HEAD_PROMPT`, `OLD_HEADPROMPT_FRAGMENT`, `BUGGY_HEADPROMPT_FRAGMENT`, `PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT`, `PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT`, `PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT`, `PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT`, `QUEUE_DONE_MARKER`, `COMMIT_INSTRUCTION_MARKER`) from `src/services/teamWiring.ts` and `src/webview/terminals.js`. Cleaned up `migrateAgentGroups` and `migrateCodingTeamOrders` (and client mirror `migrateCodingTeamOrdersClient`) by stripping prompt-text rewrite arms while retaining structural seed migration (`isUntouchedOldSeed`, `isUntouchedSeed`), member defaults, `teamGroup: true` flag migration, and pair-order conversion (`PRE_REWRITE_CALLBACK_INSTRUCTION`, `migrateTeamPairOrders`). Contract tests in `stage-marker-commit-contract.test.js` and `standing-orders-marker-contract.test.js` were updated to remove deleted snapshot assertions and verify survival of structural seed and flag migrations.
