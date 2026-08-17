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

Head prompts are carried as `team-head`-scoped standing orders (`teamWiring.ts:856-1002`), re-appended to every prompt delivered to that terminal. A lead can therefore be `/clear`ed between features and still arrive knowing to ask for the next card. The board is the state; the lead is only the pacer. This is what makes the design safe — nothing durable lives in the lead's conversation.

---

## Metadata

- **Complexity:** 5
- **Tags:** backend, api, reliability, refactor
- **Feature:** 3e8b662b-a8a8-42c5-8e43-6d67998aa201

> **Superseded:** Complexity 4.
> **Reason:** The in-flight predicate turned out to be the load-bearing design decision of the whole feature (three other subtasks rest on its `409`), and the first formulation of it deadlocked the pipeline after card one — see the correction under *In-flight refusal*. A serialization point that four callers depend on and that must survive a wrong answer in either direction is not a routine single-surface change.
> **Replaced with:** Complexity 5 — still one new endpoint over an untouched dispatch path, but with a correctness-critical predicate and a new internal seam three other subtasks call.

---

## User Review Required

**None.** Four decisions made here:

* **The endpoint pops and dispatches in one call.** A "tell me the next card" read followed by a separate dispatch is two round trips with a race between them.
* **The pop is serialized, not optimistic.** Two teams asking at once must not receive the same card.
* **A team with work in flight is refused, not queued.** The refusal is the one-in-one-out guarantee; a queue behind the endpoint would reintroduce the in-flight bookkeeping this design deletes.
* **Nothing is deleted in this plan.** It ships alongside the existing modes. Retirement is subtask 4 and depends on this plus the watchdog.

---

## Complexity Audit

### Routine

- Registering one more `pathname ===` branch in the existing chain (`LocalApiServer.ts:3850` neighbourhood) and one more `GET /catalog` row.
- Calling `performKanbanDispatch` with an options object whose shape already exists (`{ unattended?, targetTerminalOverride?, originTerminal? }`, `LocalApiServer.ts:1260`). No signature change.
- Appending a sentence to `NEW_CODING_HEAD_PROMPT` — the byte-identical-literal discipline and its contract test already exist.
- A module-level promise chain for serialization, copying the shape `mutateStandingOrders` already uses.

### Complex / Risky

- **The in-flight predicate is the whole feature's serialization point.** Subtasks 2, 4 and 6 all dispatch through this endpoint and rely on its `409`. Too strict and the head's own legitimate call is refused (the pipeline stops after card one); too loose and a schedule plus a self-pacing lead double-dispatch. It gets its own section below.
- **`targetTerminalOverride` silently disables team-scoped role resolution** (`LocalApiServer.ts:1332-1334` — the resolver runs only `if (!teamOverride ...)`). Passing it changes what "complexity routing" means for this call path in a way a reader of the phrase would not expect.
- **Two entry shapes, one behaviour.** The HTTP route and the in-process callers (subtask 4's schedule timer, subtask 6's handoff) must reach the same serialized function. If the timer loops back through localhost HTTP, or worse re-implements the pop, the single-serialization-point claim is false and every downstream deletion in subtask 4 becomes unsafe.
- **The queue source changes underneath this plan.** It ships against a `PLAN REVIEWED` fallback and switches to `DISPATCH` + `queue_position` when subtask 2 lands. Both orderings must be exercised.

---

## Edge-Case & Dependency Audit

### Race Conditions

- **Two heads, one card.** Handled by the module-level promise chain: select-and-dispatch is one critical section, so the second caller re-reads a queue the first has already drained.
- **The chain must wrap the dispatch, not just the select.** `performKanbanDispatch` is what sets `dispatched_at`; releasing the lock after the select and before the dispatch leaves a window where the second caller's in-flight check reads stale state.
- **Serialization is per-process, not per-machine.** The chain lives in the extension host that owns the API server, and every caller (route, timer, handoff) goes through it. A second VS Code window on the same workspace is out of scope — the port file is shared and one host serves the API.
- **Card moved out from under the pop.** Between select and dispatch a user can drag the card. `performKanbanDispatch` re-reads the record by planId and reports `moved`/`dispatched` from the DB after the fact (`:1360-1365`); a pop that comes back `success: false` must not consume the card's queue position — return the failure to the caller and leave the card staged.

### Security

- Localhost-only surface, unchanged from every other `/kanban/*` route. `from` is a terminal name used for team resolution and as the dispatch target; it is not interpolated into a shell or a file path.
- `from` naming a terminal on **another** team would let one team pull work "as" another. Resolve the team from `from` and dispatch to the resolved head — never trust `from` as an arbitrary target when it does not resolve to a live head. An unresolvable `from` is a `400`, not a fallback to workspace-wide routing.

### Side Effects

- **`dispatched_terminal` becomes the head, not a routed coder.** With `targetTerminalOverride: from`, complexity routing still selects the target *column* (`INTERN/CODER/LEAD CODED`) but the terminal is forced to the requesting head. The card's column will therefore read "intern" while the head holds it — intended (the head delegates subtasks), but it must be stated or the next reader treats it as a bug.
- **`teamRouting` is absent from the response** for the same reason: the resolver never runs when an override is supplied. Do not assert on it in tests of this path.
- The endpoint moves a card and starts an agent. It is not a read; it must never be reachable from a `GET`.

### Dependencies & Conflicts

- **Consumed by three siblings.** Subtask 2's `Run queue`, subtask 4's schedule, and subtask 6's handoff all dispatch through this. Exporting only an HTTP route forces two of them into a localhost round-trip against their own process.
- **Subtask 3 arms its queue watch inside this function.** That is only a single arming site if every caller reaches the same function — another reason the internal method is the real contract and the route is a wrapper.
- **Subtask 2 owns `queue_position`.** This plan reads it and must tolerate its absence (fallback below), never create it.
- No conflict with the existing automation modes: this ships alongside them and dispatches through the same path a run-sheet tick uses.

---

## Dependencies

- `7e0983cc-c3a6-44d4-be7f-5b03917153d6` — The Dispatch Column Becomes the Session Queue *(soft: supplies `queue_position` and the `DISPATCH` queue source; this plan ships against a `PLAN REVIEWED` fallback until it lands)*
- `85481036-a94d-46b0-9c46-afa0e06da994` — Queue Watch on the Idle Sweep *(reverse: subtask 3 arms inside this endpoint; ship them together before offering schedule-off pacing)*

---

## Adversarial Synthesis

**Risk summary.** The single real risk is the in-flight predicate: keyed on `dispatched_at` it refuses the head's own legitimate call and the pipeline stops after one card; keyed too loosely it lets a schedule and a lead double-dispatch. Mitigation is a column-scoped predicate (in flight = a card belonging to this team sitting in a coding column) which is mtime-independent and releases exactly when the head hands the feature to review. Secondary risks — a localhost loop-back instead of a shared internal method, and `targetTerminalOverride` silently bypassing team-scoped resolution — are both removed by explicit design decisions recorded below rather than left to the coder.

---

## Proposed Changes

### `src/services/LocalApiServer.ts`

**Context.** `performKanbanDispatch` (`:1257`) already does everything a dispatch needs; the `pathname ===` chain registers `/kanban/dispatch` at `:3850`. What is missing is a *pull* door onto the same machinery.

**Logic.** Add one internal method and one thin route over it.

```
public async dispatchNextFromQueue(args: {
    workspaceRoot: string;
    from: string;            // requesting head's terminal name
}): Promise<{ status: number; payload: any }>
```

**Implementation.**

1. **`dispatchNextFromQueue` is the contract; the route is a wrapper.** Every caller — the HTTP route, subtask 4's schedule timer, subtask 2's `Run queue` button (via its existing verb), subtask 6's handoff — calls this method in-process. No caller loops back through `http://127.0.0.1`.

   > **Superseded:** "`POST /kanban/queue/next` in `LocalApiServer.ts`, registered in the `pathname ===` chain alongside `/kanban/dispatch`" as the only entry point.
   > **Reason:** Three sibling subtasks dispatch through this path from inside the same process. An HTTP-only contract forces the extension host to make localhost round-trips against its own server, and — worse — makes "one serialization point" and subtask 3's "one arming site" untrue the moment anyone takes the shortcut of re-implementing the pop.
   > **Replaced with:** a public method carrying the serialized pop, with `POST /kanban/queue/next` as a thin body-parsing wrapper over it. The method is the contract; the route is one of its callers.

2. **`POST /kanban/queue/next`**, registered beside `/kanban/dispatch` (`:3850`). Body `{ workspaceRoot?, from }`; `from` is the head's own `SWITCHBOARD_TERMINAL`. Missing `from` → `400`.

3. **Serialize the pop.** A module-level promise chain (the shape `mutateStandingOrders` uses, `teamWiring.ts:46`) wraps **select → in-flight check → dispatch** as one critical section. Releasing the lock before the dispatch reopens the race it exists to close.

4. **Queue source.** Inside the chain, read the next `DISPATCH`-column card for this workspace with `dispatched_at IS NULL` and an empty `featureId` (subtask exclusion, `switchboard-contracts` #6), ordered by `queue_position ASC` with `NULL` last, then by the board's existing order as the tie-break. Until subtask 2 lands, fall back to `PLAN REVIEWED` in board order so this plan is independently shippable and testable.

5. **Dispatch.** `performKanbanDispatch(workspaceRoot, planId, undefined, { originTerminal: from, targetTerminalOverride: from })`. `undefined` column means complexity routing.

   **Clarification (not new scope).** `targetTerminalOverride` short-circuits the team-scoped resolver — `LocalApiServer.ts:1332-1334` runs it only `if (!teamOverride && ...)`. So on this path complexity routing chooses the *column* and the requesting head is the *terminal*, by design: the lead asked, the lead receives, and it delegates subtasks itself. Two consequences a coder must not "fix": the card's coding column may read `INTERN CODED` while the head holds it, and the response carries no `teamRouting` field.

6. **In-flight refusal — the one-in-one-out contract.**

   > **Superseded:** "If any active card carries a `dispatched_terminal` belonging to that team with `dispatched_at` set, return `409`."
   > **Reason:** This deadlocks the pipeline after the first card. The head calls `queue/next` *after its reviewer reports a pass* — and at that moment the just-reviewed card is sitting in `CODE REVIEWED` with `dispatched_at` set and `dispatched_terminal` naming that team's **reviewer** (the dispatch path overwrites those fields on the review hand-off; see the comment at `:1330-1331`). The guard would refuse the exact call the whole design depends on. The predicate is also unsound in the other direction: `dispatched_at` is cleared by a plan-file `mtime` advance (`clearWorkingState`, `PlanIngestionEngine.ts:457/1310`) or by the 10-minute staleness sweep (`clearStaleWorkingState`, `:504`), so for a feature card — whose file's mtime moves when Switchboard regenerates its subtasks block — the flag can clear itself mid-work.
   > **Replaced with:** **a team is in flight when any active card belonging to that team is sitting in a coding column** — `LEAD CODED`, `CODER CODED`, `INTERN CODED`. Team membership is resolved from the card's `dispatched_terminal` through the same path `resolveTeamRoleTerminal` uses (`TaskViewerProvider.ts:9699`). The flag releases exactly when the head hands the feature to review, which is the moment the team is genuinely free. It is derived from board position, so no `mtime` side effect and no staleness sweep can corrupt it.

   Accepted consequence, stated so it is not rediscovered as a bug: while the reviewer works card N, the team's coders are idle and the predicate says "free". A schedule (subtask 4) may therefore hand the team card N+1 during review. That is the desired behaviour — the coders are the constrained resource — and the head's own pull is naturally paced because it only asks after the pass report.

7. **Empty-queue response.** `200` with `{ success: true, dispatched: null, reason: 'queue empty' }` — not an error. An empty queue is the session ending normally, and the lead's instruction says to report and stop on that response.

8. **Failed dispatch.** When `performKanbanDispatch` returns non-2xx (no live terminal → `409` at `:1320`; card not found → `404`), pass its status and payload through unchanged and leave the card staged with its `queue_position` intact. A pop must never consume a card it did not start.

**Edge Cases.** Unresolvable `from` → `400`. `from` on a team with no coding head → `400` naming what is missing. Concurrent pops → one card, one dispatch. A card dragged out between select and dispatch → the DB-verified `success: false` from `performKanbanDispatch` is returned and nothing is consumed.

### `src/services/teamWiring.ts` — the standing order

**Context.** `NEW_CODING_HEAD_PROMPT` (`:275`) is carried as a `team-head`-scoped standing order and re-appended to every prompt that terminal receives, so it survives a `/clear`.

**Implementation.** Append: when the reviewer reports the feature passed, `POST /kanban/queue/next` with `{"from":"{head}"}`; if it returns a dispatched card, work it; if it returns `dispatched: null`, report that the queue is empty and stop. Keep the existing byte-identical-literal discipline — `kanban.html`'s Coding gallery entry carries the same string, `src/test/standing-orders-marker-contract.test.js` pins load-bearing substrings, and the rewriter at `teamWiring.ts:1239-1241` rewrites stale `team-head` rows by `indexOf` match, so all three move together.

**Edge Cases.** A head that is `/clear`ed mid-feature re-reads the order on its next prompt. A head on a team whose queue is empty must stop, not poll — the instruction says report-and-stop, and subtask 3's watch (not the lead) owns re-engagement.

### `src/webview/kanban.html` — Coding gallery entry

The same appended sentence, byte-identical to the `teamWiring.ts` literal.

### `GET /catalog` and `.agents/skills/switchboard-orchestration/SKILL.md`

Add `POST /kanban/queue/next` with its body, its three response shapes (`dispatched` card / `dispatched: null` / `409` in flight) and one line stating that the head is the expected caller.

---

## Verification Plan

### Automated Tests

- **Unit — concurrent pops.** Two `queue/next` calls for two different heads against a one-card queue; exactly one gets the card, the other gets `dispatched: null`.
- **Unit — the deadlock regression (the one that matters).** A team whose just-reviewed card sits in `CODE REVIEWED` with `dispatched_at` set and `dispatched_terminal` naming that team's reviewer **is not in flight** and receives the next card. This is the test that pins the corrected predicate.
- **Unit — in-flight refusal.** A team with a card in `CODER CODED` gets `409` naming the card; the same team after that card moves to `CODE REVIEWED` gets the next card.
- **Unit — mtime independence.** Touching a dispatched feature's plan file (clearing `dispatched_at` via `clearWorkingState`) does **not** make an actively-coding team look free.
- **Unit — empty queue** returns `200` with `dispatched: null`, not `4xx`.
- **Unit — failed dispatch preserves the queue.** With no live terminal, the pop returns the `409` from `performKanbanDispatch` and the card keeps its column and `queue_position`.
- **Unit — one entry point.** Assert the route handler delegates to `dispatchNextFromQueue` and contains no card selection of its own (the property subtasks 3 and 4 depend on).
- **Contract test** — the appended head-prompt sentence exists byte-identically in both `teamWiring.ts` and `kanban.html`'s Coding entry (extend `src/test/standing-orders-marker-contract.test.js`).
- **Regression** — existing `scheduled` mode still paces normally with the endpoint present and uncalled.

### Manual UAT

- Stage three plans, dispatch the first by hand, and let a coding team run all three with **every automation mode off**. The pipeline must advance three times with no clock running — that is the whole claim of this plan.
- Watch the second advance specifically: it is the one the old `dispatched_at` predicate would have refused.

---

**Recommendation:** Complexity 5 → **Send to Coder.**

---

## Completion Report

Implemented `POST /kanban/queue/next` as a thin HTTP wrapper over a new public `dispatchNextFromQueue` method — the in-process contract three sibling subtasks dispatch through. The pop is serialized by a module-level promise chain (`_queueNextChain`) that wraps select → in-flight check → dispatch as one critical section, so two heads asking at once never receive the same card. The in-flight predicate is column-scoped (a team is in flight when any of its cards sits in `LEAD CODED`/`CODER CODED`/`INTERN CODED`), keyed on team membership resolved via a new `resolveTeamMembersForHead` helper in `teamWiring.ts` (identical `terminals.groups` path to `resolveTeamScopedRoleTerminal`) and wired through a new `resolveTeamMembers` callback + `TaskViewerProvider.resolveTeamMembers` — not on `dispatched_at`, so the just-reviewed card in `CODE REVIEWED` no longer deadlocks the pipeline after card one. Queue source prefers DISPATCH-column cards (queue_position ASC NULLS LAST) and falls back to PLAN REVIEWED in board order until subtask 2 lands; subtasks excluded via empty `featureId`; empty queue returns `200 { dispatched: null }`; failed dispatches pass through with the card staged.

Files changed: `src/services/LocalApiServer.ts` (method + route + serialization chain + `resolveTeamMembers` option + `CODING_COLUMNS`), `src/services/teamWiring.ts` (`resolveTeamMembersForHead` + appended queue/next sentence to `NEW_CODING_HEAD_PROMPT`), `src/services/TaskViewerProvider.ts` (`resolveTeamMembers` method + import + callback wiring), `src/webview/kanban.html` (byte-identical queue/next sentence appended to the Coding gallery headPrompt only), `protocol-catalog.json` (route entry + count bump), `.agents/skills/switchboard-orchestration/SKILL.md` (endpoint doc row), `src/test/standing-orders-marker-contract.test.js` (full byte-identity assertion between the two headPrompts + queue/next sentence presence). No issues encountered; forbidden files (KanbanDatabase.ts, KanbanProvider.ts, Dispatch view, PlanIngestionEngine.ts) untouched, and the kanban.html edit was a targeted string edit on the headPrompt only.
