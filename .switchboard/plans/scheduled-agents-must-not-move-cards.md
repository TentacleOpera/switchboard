# A Scheduled Agent Never Moves A Card

## Goal

Make scheduling safe to leave running overnight without thought. A scheduled run must never be
able to strand, double-advance or reverse a card. The way to get that is not to instruct agents
carefully — it is to ensure no scheduled agent has any reason or route to move a card, and that
everything which does move cards is deterministic host code going through dispatch.

### The problem, and the root cause

Today a team automation can be given board authority by a checkbox — *"Allow automation to move
board cards (includes board driving contract)"* (`terminals.html:2637`) — which renders as a
violet `MOVES CARDS` badge. What that checkbox actually does, in full
(`schedulerPresets.ts:115`):

```
if (job.teamTarget?.canMoveCards) {
    return `${basePrompt}\n\n${BOARD_DRIVING_CONTRACT}`;
}
```

`BOARD_DRIVING_CONTRACT` is a paragraph of prose telling the agent to use `move-card.js` /
`POST /kanban/move` rather than raw SQL, and where to find the API port. So:

- **It grants nothing and restricts nothing.** Unticked, the agent is not prevented from moving
  cards — it is merely not told the sanctioned route, which makes a raw-SQL move *more* likely,
  not less. The checkbox is inverted relative to its label.
- **It bypasses every guard.** A real dispatch goes through `dispatchNextFromQueue` →
  `_queueNextChain` → the team in-flight check → a 409. A prompted move goes through none of it,
  so an automation can move a card while its team is holding other work and nothing refuses.
- **It leaves no holder.** Dispatch writes `dispatched_terminal` / `dispatched_at`, which
  `completed_at` later releases. A prompted move writes neither, so the card advances with no
  holder — invisible to the in-flight predicate, to mission `runState`, and to the rail.

**And prose restrictions on card movement are already known not to hold.**
`team-heads-must-not-move-cards.md` exists because a hand-tuned standing-orders prompt failed
twice in observed use: a lead moved a card backwards from CODER CODED to PLAN REVIEWED, and
another read the word "advance" as "move the card". If that fails for a lead being watched, it
fails for a job running at 03:00.

The root cause is that card movement was modelled as a *permission granted by prompt* rather
than as an operation with an owner. `reconcile` has the same shape and its own source comment
concedes the exposure: *"A wrong prompt silently moves cards backward or double-advances, so
the wording is load-bearing."*

## Metadata
- **Complexity:** 4
- **Tags:** backend, reliability, security, refactor

## Why this is not enforced at the endpoint

The obvious fix — refuse `/kanban/move` from a scheduled agent — is not available.
`_handleKanbanMove` takes `sessionId | planId`, `targetColumn`, `workspeaceRoot`, `planFile`
and **no caller identity**, unlike `/kanban/dispatch` and `/kanban/task/complete` which both
carry `from`. Adding `from` only half-closes it: the panel's own drags arrive unattributed and
must keep working, so an agent that omits `from` walks through the gate. That fails open, which
is the wrong failure mode for the feature whose entire promise is that it is unattended.

Hence the design below: remove the reason, not the route.

## The rule

**In a scheduled context, the host may move cards; an agent may not.**

- **Host-executed actions** — anything that advances the board — run as deterministic code
  through the dispatch path, with a recorded holder and the in-flight guard. No judgement, no
  prompt.
- **Agent actions** — recurring prompt delivery — have no board reach at all. A mistake costs a
  wasted run, never a stranded card.

## No migration

Clean break. `canMoveCards` is deleted, not migrated or defaulted. It has never been used, so
no persisted job carries it — but write the reader to ignore an unknown key rather than throw,
since jobs are stored in a shared config blob. CLAUDE.md's migration rule is waived otherwise.

## Implementation

1. **Delete `canMoveCards`** from `ScheduledJob.teamTarget`
   (`GlobalIntegrationConfigService.ts:55`), from the team automations form
   (`terminals.html:2630-2640`), from the card badge (`terminals.js`, the `MOVES CARDS` badge),
   and from `buildTeamAutomationPrompt` (`schedulerPresets.ts:110-120`).
2. **Keep `BOARD_DRIVING_CONTRACT` only where a human-driven agent needs it.** It is still the
   correct instruction for an interactive agent that legitimately moves cards; it is exported
   and aliased by `KanbanProvider.BOARD_DRIVING_CONTRACT`, so check every consumer before
   deleting the constant. What goes is its use in *scheduled* presets.
3. **`reconcile` stops being an agent prompt** — owned by `reconcile-becomes-host-code.md`,
   which this plan depends on. Until that lands, `reconcile` is the one scheduled job that
   still moves cards by prose, and this plan is not complete while it does.
4. **Add the rule where a future author will hit it** — a comment on `buildTeamAutomationPrompt`
   and on the scheduled-job runner stating that scheduled prompts carry no board authority and
   that board actions are host-executed. The next `canMoveCards` gets added because nothing says
   otherwise.
5. **Assert it in a test**, not just in prose: no scheduled prompt builder may emit
   `BOARD_DRIVING_CONTRACT`, `move-card.js` or `/kanban/move`. A string assertion over the
   preset builders is cheap and is the only thing that will still be true in six months.

## Edge cases

- **An operator who *wants* a scheduled agent to move cards.** The answer is a host-executed
  board action (`advance-plan`, `advance-feature`), not a prompt. If no host action covers the
  case, that is a gap to fill with an action — not with prompt authority.
- **`move-card.js` is a skill script, not only an endpoint.** An agent with shell access can run
  it regardless of what its prompt says. This plan reduces the reason, not the capability —
  state that limit honestly in the code comment rather than implying the route is closed.
- **Deleting the checkbox must not orphan stored jobs.** A persisted job with
  `teamTarget.canMoveCards: true` must load and run, minus the appended contract.
- **The badge's absence is the only signal an operator gets** that behaviour changed. Since no
  one has used it, no notice is needed — but confirm nothing else keys on the badge's presence.

## Verification plan

1. `npm run compile` clean.
2. Grep `canMoveCards`: zero live references outside historical plan files.
3. Test: every scheduled prompt builder's output contains no `BOARD_DRIVING_CONTRACT`, no
   `move-card.js`, no `/kanban/move`.
4. Load a config whose stored job has `teamTarget.canMoveCards: true`; confirm it loads, runs,
   and delivers a prompt with no contract appended.
5. Team automations still create, edit, enable and `RUN NOW` with the checkbox gone and no
   layout breakage in the form.
6. Confirm interactive (non-scheduled) agents that legitimately move cards still receive
   `BOARD_DRIVING_CONTRACT` wherever they did before.
7. Both hosts.
