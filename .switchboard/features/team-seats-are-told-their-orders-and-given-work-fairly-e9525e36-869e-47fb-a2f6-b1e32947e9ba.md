# Team seats are told their orders and given work fairly

**Complexity:** 5

## Goal

Two defects in how a team treats its seats, both reached through teamWiring.ts and the prompt-delivery chokepoints. Standing orders are installed as config rows and only ever rendered onto an outbound prompt, so a seat that is started and left alone is told nothing. And the head prompt tells the lead to hand the next subtask back to the coder that just reported, naming no other seat and carrying no idle signal, so one coder is run to its context limit while its siblings sit at an idle prompt.

## How the Subtasks Achieve This

- **Relay Standing Orders to a Seat the Moment It Starts, Not Only When Someone Dispatches to It:** Adds a fire-and-forget startup orientation relay in both hosts (extension + standalone) that waits for CLI quiescence after `create()`, then sends a one-line carrier through the existing `applyStandingOrders` chokepoint — gated inside the delivery layer so a seat with no orders receives nothing. Closes the gap between order installation (create time) and order delivery (prompt time) by producing the missing event: a bare relay at startup.
- **A Team Lead Must Spread Subtasks Across Idle Seats, Not Burn One Coder to Its Context Limit:** The V3 head-prompt text (spread rule) is already shipped in `NEW_CODING_HEAD_PROMPT` and its byte-identical copies. This subtask adds the V2→V3 migration recogniser to `migrateCodingTeamOrders` and its client mirror so persisted `team-head` standing-order rows on existing installs are rewritten from the old sticky-assignment rule to the spread rule on read. Extends the pin test with the V2 fragment negative assertion and new spread-rule literals.

## Dependencies & sequencing

- **Shipping order:** The V2 migration (spread subtasks) should land **before or with** the startup relay (standing-orders relay). The relay delivers whatever effective orders resolve to — if it ships without the V2 migration, a V2-bearing install relays the old sticky-assignment rule to the head at startup, which is the exact behaviour the spread subtask fixes. Landing the migration first ensures the relay delivers V3 text to every install.
- **No hard dependency:** The relay works correctly regardless of ordering — it delivers whatever `loadEffectiveStandingOrders` resolves. The ordering constraint is about delivering the *correct* text, not about functional correctness.
- **Shared surface:** Both subtasks touch `src/services/teamWiring.ts` but different symbols — the relay reads `wireSpawnedTeam` (no modification); the migration modifies `migrateCodingTeamOrders` and adds `OLD_HEADPROMPT_V2_FRAGMENT`. No file-level conflict; same-file edits serialise per the PRD's orchestration discipline.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Relay Standing Orders to a Seat the Moment It Starts, Not Only When Someone Dispatches to It](../plans/feature_plan_20260817101500_relay-standing-orders-on-terminal-startup.md) — **PLAN REVIEWED** — ID: 3a53a219-24d0-4a44-b789-5c2730e470ac
- [ ] [A Team Lead Must Spread Subtasks Across Idle Seats, Not Burn One Coder to Its Context Limit](../plans/feature_plan_20260817101700_lead-spreads-subtasks-across-idle-seats.md) — **PLAN REVIEWED** — ID: b684296c-0a14-4271-aace-3dfc872c06ee
<!-- END SUBTASKS -->

## Implementation Summary

Startup orientation now waits for seat quiescence and relays effective standing orders through the existing delivery chokepoint in both the extension and standalone hosts. The no-orders gate drops bare carrier prompts, and team creation paths relay only after wiring has installed their orders, including external-headed teams. Persisted V2 team-head orders now migrate to the fair idle-seat distribution text in both the host and client mirror. Contract coverage was added for relay behavior, host wiring, migration, and prompt parity; automated tests and compilation were not run under this run's explicit verification override.


## Review Findings

Reviewed commit `77c5ec65`; both halves achieve the feature goal. The relay fires once per seat across all four create paths in both hosts, always after `wireSpawnedTeam` resolves, and drops the send when the seat resolved no orders — verified against the writers: `ptyListTerminals` really does project `status` and `lastDataAt` in both hosts, `instantiateAgentGroupCore.created` really is a string array including the head, and `instantiateExternalHeadedTeam.workers` really are objects with `friendlyName`. The V2→V3 head-prompt migration rewrites persisted `team-head` rows on read in host and client mirror, and its recogniser fragment is absent from its own replacement. The implementation summary recorded that tests and compilation were skipped; I ran them. Files changed in review: `package.json` and `.github/workflows/integration-tests.yml`, to wire `startup-orientation-relay-contract.test.js` — 23 passing assertions that no gate invoked.

## Deferred Findings

- MAJOR — `src/services/teamWiring.ts:648` — `OLD_HEADPROMPT_V2_FRAGMENT` restores the frozen head-prompt-recogniser pattern that was deliberately abandoned for never-shipped team state; needs an author decision, not a reviewer edit.
- MAJOR — `src/services/TaskViewerProvider.ts:1283` — the relay probe reads `hiddenTerminals`, which has no writer anywhere in the codebase.
- NIT — `src/services/startupOrientation.ts:54` — the no-output `else` branch and `ORIENTATION_NO_OUTPUT_MS` are dead, and a drift pin now anchors a constant nothing reads.
- NIT — both hosts suppress the seat block on the relay, contradicting the plan's edge-case table, which expected the relay to warm `_seatBlockCache`. Safe direction; worth recording.
- MAJOR (pre-existing, not this commit) — `stage-marker-commit-contract.test.js:523,:614` and `team-scoped-role-routing.test.js:628,:923` are red at HEAD.
