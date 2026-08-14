# Retire the Orchestrator's Bespoke Machinery — No Wake Cadence, No File Inbox, No Dispatch Endpoint

## Goal

Delete the orchestrator's plumbing — the wake cadence, the file inbox, the `last-wake-complete` handshake and the batch-into-one-worktree dispatch — and rewrite the persona as an agent that reads the board, messages the team leads that already exist, and handles merge-back.

The orchestrator stops being a subsystem the extension drives and becomes an ordinary agent with a skill. What survives is its judgement work, not its machinery.

### Problem & background

**Every piece of this machinery exists to manage an agent that could not be messaged.** The orchestrator (`startOrchestratorFromKanban`, `TaskViewerProvider.ts:9844`) launches a persona terminal, injects a kickoff prompt, and tells it to sleep. An autoban wake tick (`~:11549-11640`) later dispatches a Wake Protocol prompt; the persona drains `.switchboard/orchestrator/inbox/` and touches `.switchboard/orchestrator/last-wake-complete`; the extension `stat`s that file's mtime against `_orchestrationWakeSentAt` (`:11592-11597`), counts skipped wakes, and force-recovers after `ORCHESTRATION_MAX_SKIPPED_WAKES` (`:11601-11607`).

Agents can message each other. `POST /terminals/verb/ptySendPrompt` is documented in two skills, and `AGENT_GROUP_CALLBACK_INSTRUCTION` (`teamWiring.ts:46`) already installs "when you finish a task, report to your head" as a standing order on every team member. Sending a prompt to an idle CLI terminal starts a turn — **that is the wake.** The cadence polls because the original design had nothing that could push; that is no longer true.

**The inbox is a channel with no trigger.** `.switchboard/orchestrator/inbox/` is drained only when a wake fires, so a request written between wakes sits unread — the same defect as the retired instruction inbox and the declared-moves channel: information written where nothing is triggered to read it. Direct messaging replaces it.

**The dispatch endpoint fans out the wrong unit.** `_orchestrationDispatchFeature` (`:10068`) sends a feature's eligible subtasks **as one batch to a single shared worktree terminal**, capped by `maxConcurrentSubtasks`. An orchestrator that messages the leads that already exist does not need the extension to fan out on its behalf.

**Teams do not need to be spawned as the orchestrator's children.** A team's members spawn automatically when an unparented terminal whose role heads a team is created — that path works today. The orchestrator messages leads that are running; it does not own them. No recursion, no depth limit, no parentage bookkeeping.

**What the cadence uniquely provided is covered elsewhere.** Its one irreplaceable job was noticing that a seat went quiet and nobody reported. That is the sibling card: turn-end is already derived from pty output silence (`PlanIngestionEngine.ts:376-401`) and already distinguishes finished from blocked; the sibling adds the notification. That is a push on a real event, not a poll on a clock.

**No durable in-flight state is needed.** What is in flight is already persisted: cards, columns, `dispatched_at`, `blocked_at`, worktrees — all in the kanban DB. An orchestrator that wakes re-reads the board. A bespoke store would duplicate the board and then have to be reconciled against it.

---

## Metadata

**Complexity:** 5
**Tags:** backend, refactor, reliability

---

## User Review Required

**None.** Five decisions made here:

* **The wake cadence is deleted, not made optional.** Replaced by direct messaging plus the sibling card's turn-end notification.
* **The file inbox and `last-wake-complete` go with it.** Agents message each other.
* **`POST /kanban/orchestration/dispatch` and `_orchestrationDispatchFeature` go.** The orchestrator dispatches by messaging leads.
* **No durable in-flight state and no second watchdog.** The board is the state; the sibling card is the watchdog.
* **Grouping plans into features and worktree merge-back stay** — as skill content, not extension code.

---

## Complexity Audit

* **Score:** 5 / 10

### Routine

* Deleting a wake tick, a file-inbox handler, three HTTP routes and a stat-based handshake.
* Removing three counters, two constants and a force-recover branch.

### Complex / Risky

* **Deleting the cadence removes the only thing that currently restarts a stalled orchestrator.** The sibling notification card must land first. This is an ordering constraint, not a preference.
* **The persona rewrite is a deliverable no gate checks.** A skill that still tells the agent to drain a deleted inbox is a live instruction to do something impossible, and a rewritten skill reported as done but never written is invisible to CI.
* **Several agent-facing documents describe the removed routes.** A contracts document that describes a deleted endpoint is worse than none.

---

## Edge-Case & Dependency Audit

### Race Conditions

* **A turn-end notification arriving while the orchestrator is mid-turn.** Prompt delivery to a busy terminal is the existing `ptySendPrompt` behaviour and is not changed here; the orchestrator reads the board at the start of each turn, so a late notice is absorbed rather than lost.
* Removing the cadence removes the `_autobanTickQueue` single-flight around wakes. Confirm nothing else depended on that serialisation.

### Security

* Not a privilege change.
* **Do not delete anything under a user's `.switchboard/orchestrator/` on disk.** Removing the reader is not licence to remove their session logs or past inbox contents.

### Side Effects

* Behaviour changes for anyone running orchestration mode today: work advances on messages instead of on a timer.
* Removing `POST /orchestrator/request` and `GET /orchestrator/inbox` breaks any agent still following the old skill — which is why the persona rewrite ships in the same change, not after it.

### Dependencies & Conflicts

* **Sibling card — turn-end notification.** Hard prerequisite. Do not delete the cadence before it lands.
* **`src/services/TaskViewerProvider.ts`** — `startOrchestratorFromKanban` (`:9844`), the kickoff prompt (`:9978-10005`), the stale-marker cleanup (`:10019-10023`), the wake tick (`~:11549-11640`), `_orchestrationDispatchFeature` (`:10068`), `_handleOrchestratorInboxRequest` (`:4962`), the verb arms routing to them (`:2794-2802`), `_orchestrationWakeSentAt` (`:784`), `_orchestrationSkippedWakes` (`:782`), the resets (`:11757-11759`), and the orchestration branch of `_startAutobanEngine` (`:11669-11684`).
* **`src/services/autobanState.ts`** — `ORCHESTRATION_MAX_SKIPPED_WAKES` (`:22`) and `ORCHESTRATION_MAX_FAILED_WAKES` (`:23`) live here, not in `TaskViewerProvider`; `ORCHESTRATION_TICK_KEY` (`:19`); and `OrchestrationConfig` (`:36-41`), whose `intervalMinutes` and `lastWakeAt` serve only the cadence and whose `maxConcurrentSubtasks` serves only the dispatch being removed. `enabled` stays — it still means "orchestrator session armed".
* **`src/services/LocalApiServer.ts`** — `POST /orchestrator/request` (`:3999`), `GET /orchestrator/inbox` (`:4029`), `POST /kanban/orchestration/dispatch` (`:3969`), the `orchestrationDispatch` option (`:311`) and its handler (`:2552-2588`).
* **`src/webview/kanban.html:11753`** — the orchestration status line renders `' · last wake ' + new Date(o.lastWakeAt)`; its only writer is `TaskViewerProvider.ts:11630-11636` and goes with the tick. Do not leave a status line reporting a wake that no longer happens.
* **`.agents/skills/switchboard-orchestrator/SKILL.md`** — the Kickoff/Wake Protocol split, the dispatch step, the inbox drain, the `last-wake-complete` touch and the Comms Reference inbox format.
* **`.agents/skills/switchboard-orchestration/SKILL.md`** and **`switchboard-contracts`** — audit for references to the removed routes and update in the same change.

---

## Dependencies

* **Hard prerequisite:** the turn-end notification card.
* No dependency on nested teams, delegate endpoints, or any new persistence.

---

## Adversarial Synthesis

Key risks: (1) **deleting the cadence before the notification lands** turns a stall into a silent stop, the worst outcome for an unattended board; (2) **the persona rewrite is unverifiable by CI**, so the code half can land green while the skill still instructs agents to drain a deleted inbox; (3) **removing routes breaks agents still on the old contract**, including the two other agent-facing skills that document them; (4) **partial deletion** — leaving the status line, a constant, or a config field whose only purpose was the cadence. Mitigations: land the sibling card first and verify a real push before touching the cadence; ship the skill rewrite in the same change and verify by reading the file, not the report; delete the routes and the instructions that call them together; grep the named symbols to zero rather than trusting the change list.

---

## Proposed Changes

**Build order:** (1) delete the machinery → (2) rewrite the persona. Both land after the sibling notification card.

### 1. Delete the orchestrator's bespoke machinery

**Implementation:** remove

* the wake tick and its state — `_orchestrationWakeSentAt`, `_orchestrationSkippedWakes`, the force-recover branch, the Wake Protocol dispatch (`~:11549-11640`), the resets (`:11757-11759`), the orchestration branch of `_startAutobanEngine` (`:11669-11684`), and `ORCHESTRATION_MAX_SKIPPED_WAKES` / `ORCHESTRATION_MAX_FAILED_WAKES` / `ORCHESTRATION_TICK_KEY`;
* the `last-wake-complete` stat handshake and the stale-marker cleanup (`:10019-10023`);
* `_handleOrchestratorInboxRequest` (`:4962`) and the `POST /orchestrator/request` / `GET /orchestrator/inbox` routes;
* `_orchestrationDispatchFeature` (`:10068`), the `orchestrationDispatch` option and handler, and `POST /kanban/orchestration/dispatch`;
* `OrchestrationConfig.intervalMinutes`, `.lastWakeAt` and `.maxConcurrentSubtasks`, keeping `enabled`;
* the last-wake status line (`kanban.html:11753`) and its writer (`:11630-11636`).

**Edge cases:** do **not** delete anything under a user's `.switchboard/orchestrator/` on disk. Persisted `orchestrationConfig` objects still carrying removed keys must normalise cleanly — ignore unknown keys, do not reject. No tombstone comments.

### 2. Rewrite the persona

**Implementation:** rewrite `.agents/skills/switchboard-orchestrator/SKILL.md` as an agent that:

* reads the board and the feature files to decide what needs doing;
* messages the team leads that already exist, via `ptySendPrompt` with `clearBeforePrompt: false`, and asks them to report back when done;
* handles what comes back — including the extension's turn-end notice when a lead goes quiet without reporting;
* keeps its judgement work: grouping plans into features, deciding which team gets what, worktree lifecycle and merge-back, and the transitions autoban does not own — into PLAN REVIEWED and into CODE REVIEWED, including writing user decisions into the plan and handling research gaps;
* moves cards only via `move-card.js` / `POST /kanban/move`, never direct SQL. That rule survives unchanged.

Remove the Kickoff/Wake Protocol split, the inbox drain, the `last-wake-complete` touch, the dispatch-endpoint step and the Comms Reference inbox format. Update the kickoff prompt at `TaskViewerProvider.ts:9978-10005` to match. Audit `switchboard-orchestration` and `switchboard-contracts` for the removed routes. Regenerate the `.claude/` mirror (`npm run mirror:check`).

**Edge cases:** this is the deliverable most likely to be reported complete and not done. Verify by reading the rewritten skill for the removed mechanisms by name.

---

## Verification Plan

Tests are skipped per session directive, and compilation is skipped per session directive.

### Automated Tests

* Grepping `src/` for `last-wake-complete`, `orchestrator/inbox`, `_orchestrationWakeSentAt`, `_orchestrationSkippedWakes`, `ORCHESTRATION_MAX_SKIPPED_WAKES`, `ORCHESTRATION_TICK_KEY`, `orchestrationDispatch` and `_orchestrationDispatchFeature` returns nothing.
* A persisted `orchestrationConfig` containing `intervalMinutes`, `lastWakeAt` and `maxConcurrentSubtasks` normalises without error.
* Starting orchestration mode installs no timer.
* Grepping the rewritten skill for `last-wake-complete`, `inbox` and `orchestration/dispatch` returns nothing, and `npm run mirror:check` passes.

### Manual Verification

1. **No cadence:** start the orchestrator and confirm nothing polls — no wake prompt on an interval, nothing stat-ing `last-wake-complete`.
2. **Message-driven:** confirm the orchestrator acts when a lead reports back, and when the extension's turn-end notice arrives for a lead that didn't.
3. **User files intact:** confirm `.switchboard/orchestrator/` on disk is untouched.
4. **Read the skill:** open the rewritten persona and confirm it describes an agent that reads the board and messages leads, with no wake protocol and no inbox.
5. **Status line:** confirm the AUTOMATION tab shows no stale "last wake" reading.

---

## Recommendation

Complexity 5 → **Send to Coder.**

**The thing to get right:** do not delete the cadence before the sibling turn-end notification is landed and verified pushing. The cadence is currently the only thing that restarts a stalled orchestrator; removing it first converts a stall into a silent stop, which is the exact failure this feature exists to eliminate.

**Second:** the persona rewrite is a deliverable, not documentation cleanup. Nothing in CI reads a markdown file, so verify it by reading it.

**Migration:** none in the database. User files under `.switchboard/orchestrator/` are left in place. Config keys that lose their meaning are ignored on load, not rejected.
