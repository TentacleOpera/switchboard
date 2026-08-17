# The Coding Lead Paces Its Own Pipeline — `POST /kanban/queue/next`

## Goal

A coding team lead that has just finished a feature asks for the next one and gets it — no clock, no second agent deciding. One endpoint pops the next staged card, dispatches it through the dispatch path that already exists, and returns what it dispatched. One sentence added to the coding head's standing order tells the lead to make that call when review passes.

### Problem & background

**Four of the five steps in a feature's life are already agent-driven pushes. The fifth is why three automation subsystems exist.**

Trace a feature through a coding team today:

1. A coder finishes a subtask → a standing order pushes a report to the head (`AGENT_GROUP_CALLBACK_INSTRUCTION`, `src/services/teamWiring.ts:54`).
2. The head notes it and hands that coder the next subtask (`NEW_CODING_HEAD_PROMPT`, `teamWiring.ts:275`).
3. Every subtask done → the head makes one call: `POST /kanban/dispatch` on the feature with `targetColumn: CODE REVIEWED`. That single call moves the card, `/clear`s the reviewer and builds the reviewer's own prompt (`performKanbanDispatch`, `src/services/LocalApiServer.ts:1257`).
4. The reviewer finishes → reports to the head (reviewer members carry `relationship: 'reports-to-head'`).
5. The head now holds a passing feature and **has no instruction to ask for more work.** Its prompt ends "Only advance the feature your team worked; leave other cards alone."

Step 5 is the entire reason `scheduled`, `agent-managed` and `external` exist (`AutobanAutomationMode`, `src/services/autobanState.ts:49`). `scheduled` walks a two-step run sheet on an interval (`DEFAULT_AUTOBAN_RUN_SHEET`, `autobanState.ts:81`); `agent-managed` wakes an orchestrator every N minutes to decide; `external` exports a cron prompt for another tool. Three subsystems filling one gap that steps 1–4 already demonstrate a message can fill.

**The dispatch machinery is not the problem and is not being replaced.** `performKanbanDispatch` already does complexity routing, team-scoped reviewer resolution, gate pre-flight, and `/clear`-before-prompt. This plan does not touch it. What it adds is a *pull* entry point to the run sheet's own second step (`PLAN REVIEWED → coder head`), so the lead requests the dispatch instead of a timer pushing it.

### Root cause — the pacer was never allowed to be the agent that already knows

The clock exists because the original design had nothing that could push. That stopped being true when agents gained the ability to message each other, and the retired orchestrator machinery already proved the point: its wake cadence, file inbox and `last-wake-complete` handshake were all deleted in favour of direct messaging. This is the same deletion, one layer down — the pacing clock instead of the waking clock.

### Why this also removes a class of spooky failure

Board progression is currently gated on a **filesystem side effect**. Completion is inferred from the first plan-file `mtime` advance after `dispatched_at` is set (`switchboard-contracts` #2), which is why plan files must be write-once-at-the-end and why a mid-work plan edit breaks pacing for every card in the lane. Under a pull model the board advances only when the lead explicitly asks, so mtime stops being load-bearing for progression and degrades to driving the activity light. That is a genuine reduction in coupling, not a relocation of it.

### Why the instruction survives a context wipe

Head prompts are carried as `team-head`-scoped standing orders (`teamWiring.ts:848`), re-appended to every prompt delivered to that terminal. A lead can therefore be `/clear`ed between features and still arrive knowing to ask for the next card. The board is the state; the lead is only the pacer. This is what makes the design safe — nothing durable lives in the lead's conversation.

---

## Metadata

- **Complexity:** 4
- **Tags:** backend, api, reliability, refactor
- **Feature:** 3e8b662b-a8a8-42c5-8e43-6d67998aa201

---

## User Review Required

**None.** Four decisions made here:

* **The endpoint pops and dispatches in one call.** A "tell me the next card" read followed by a separate dispatch is two round trips with a race between them.
* **The pop is serialized, not optimistic.** Two teams asking at once must not receive the same card.
* **A team with work in flight is refused, not queued.** The refusal is the one-in-one-out guarantee; a queue behind the endpoint would reintroduce the in-flight bookkeeping this design deletes.
* **Nothing is deleted in this plan.** It ships alongside the existing modes. Retirement is plan 4 and depends on this plus the watchdog.

---

## Implementation

1. **`POST /kanban/queue/next`** in `LocalApiServer.ts`, registered in the `pathname ===` chain alongside `/kanban/dispatch` (`:3850`). Body: `{ workspaceRoot?, from }` — `from` is the requesting head's terminal name (the lead knows it as `SWITCHBOARD_TERMINAL`).

2. **Serialize the pop.** A module-level promise chain (the shape `mutateStandingOrders` uses, `teamWiring.ts:46`) wraps select-then-dispatch so concurrent callers cannot select the same row. Inside the chain: read the queue's next eligible card, then call `performKanbanDispatch(workspaceRoot, planId, undefined, { originTerminal: from, targetTerminalOverride: from })` — `undefined` column means complexity routing, which is what the run-sheet step did.

3. **Queue source.** Read the next `DISPATCH`-column card with `dispatched_at IS NULL`, `featureId` empty, ordered by the queue order plan 2 establishes. Until plan 2 lands, fall back to `PLAN REVIEWED` in board order so this plan is independently shippable and testable.

4. **In-flight refusal.** Resolve the requesting head's team via the same path `resolveTeamRoleTerminal` uses. If any active card carries a `dispatched_terminal` belonging to that team with `dispatched_at` set, return `409` naming the card in flight. This is the one-in-one-out contract, enforced server-side rather than trusted to the lead.

5. **Empty-queue response.** Return `200` with `{ success: true, dispatched: null, reason: 'queue empty' }` — not an error. An empty queue is the session ending normally, and the lead's instruction says to report and stop on that response.

6. **Head prompt.** Append to `NEW_CODING_HEAD_PROMPT` (`teamWiring.ts:275`): when the reviewer reports the feature passed, `POST /kanban/queue/next` with `{"from":"{head}"}`; if it returns a dispatched card, work it; if it returns `dispatched: null`, report that the queue is empty and stop. Keep the existing byte-identical-literal discipline — `kanban.html`'s Coding gallery entry carries the same string and the marker-contract test pins load-bearing substrings, so both move together.

7. **Catalog.** Add the endpoint to `GET /catalog` and to the `switchboard-orchestration` skill's route table.

---

## Verification Plan

- **Unit:** concurrent pops. Fire two `queue/next` calls for two different heads against a one-card queue; exactly one gets the card, the other gets `dispatched: null`.
- **Unit:** in-flight refusal. A team with a dispatched card gets `409`; the same team after that card reports gets the next card.
- **Unit:** empty queue returns `200` with `dispatched: null`, not `4xx`.
- **Contract test:** the appended head-prompt sentence exists byte-identically in both `teamWiring.ts` and `kanban.html`'s Coding entry.
- **Manual UAT:** stage three plans, dispatch the first by hand, and let a coding team run all three with **every automation mode off**. The pipeline must advance three times with no clock running — that is the whole claim of this plan.
- **Regression:** existing `scheduled` mode still paces normally with the endpoint present and uncalled.
