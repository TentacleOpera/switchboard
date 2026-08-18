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
- [ ] [Relay Standing Orders to a Seat the Moment It Starts, Not Only When Someone Dispatches to It](../plans/feature_plan_20260817101500_relay-standing-orders-on-terminal-startup.md) — **PLAN REVIEWED**
- [ ] [A Team Lead Must Spread Subtasks Across Idle Seats, Not Burn One Coder to Its Context Limit](../plans/feature_plan_20260817101700_lead-spreads-subtasks-across-idle-seats.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

