# Trackers are for bulk queueing, and the orchestrator is a PM you consult — not a per-card trigger

**Complexity:** 5

## Goal

ClickUp, Linear and Notion are used here for bulk moves and long-running queues — you check a project while away, advance cards into a column, and let the teams drain it. The orchestrator is an optional project-management layer on top of that: board organisation, advice on which plans to queue and whether worktrees are needed, pre-flight checks, and a simpler front end than the teams UI for anyone driving everything through an external agentic app. Two mechanisms contradict both of those facts. Remote staging auto-seats an orchestrator on the exact path RemoteControlService declares must hold no judgement, via a flag whose documented behaviour was removed and whose implementation now only presses Start orchestrator. And a tracker comment re-dispatches a whole column role, which is per-card micro-control, is a hardcoded empty stub on ClickUp, and has no way to reach the PM layer at all. This feature deletes the automatic wake, gives the orchestrator a remote inbox that works identically on all three providers, and retires the comment trigger once its replacement exists. Deliberately excluded: no new automatic orchestrator triggers, no notification system since the trackers already have their own, and no ClickUp comment bus.

## How the Subtasks Achieve This

- **Remote staging auto-seats the orchestrator, in the one path the code says must hold no judgement**: `RemoteControlService.ts` contradicts itself 40 lines apart. At `:771-774` the staging branch declares *"No agent is woken — staging is mechanical, and no judgement belongs in the correctness path of the one mechanism whose value is having none."* At `:727`, on that same path, `queueSequencing` wakes an orchestrator. And the flag no longer does what it claims: its docblocks at `:60-68` and `:148` describe *"reorder by dependency / group into features"*, but `KanbanProvider:2639` only calls `startOrchestratorFromKanban`, logs a count, and returns. The grouping half was deliberately removed — the `manage-features` skill records it — and left the flag, the dep, an unused `SEQUENCING_BOUND_MS`, and the prose behind. With individual plan enqueue, grouping before dispatch has nothing to do anyway. This subtask deletes all of it.
- **There is no way to ask the orchestrator anything from a tracker — add an instructions column whose cards are messages, not work**: the orchestrator is an optional project-management layer reached deliberately, and from a tracker there is no door at all. Every remote delta is interpreted as a plan. This subtask adds a card type that routes to the PM as a message — no plan file, no queue position, no role dispatch — and writes the reply back onto the originating card so the tracker's own notification bells do the alerting. It needs no new transport: `fetchStateDeltas` (`:675`), `stateKeyToColumn` (`:694`), `postManagedComment` / `updateIssueDescription`, and the provider factory (`KanbanProvider:2534/2539/2544`) are already all three providers. What is missing is only the card type and its routing.
- **A tracker comment re-dispatches a column agent — retire the per-card trigger**: `_remoteDispatchComment` (`KanbanProvider:3077`) appends the comment to the plan file and then calls `_remoteDispatchColumnAgent` — *the same command a manual drag uses*. So a comment on a card mid-code starts the coder again. That is per-card micro-control, it is a hardcoded empty stub on ClickUp, and it cannot reach the PM layer. This subtask retires the dispatch once the instructions column exists — while explicitly preserving the *discipline* around it: `authoredBySelf` against feedback loops, the capped seen-set against Notion's inclusive minute-rounded cursor, and cursor-stall-on-failure for at-least-once delivery are the reference implementation the instructions column should follow.
- **The standalone clipboard payload is unusable by the hosts it exists for, and the create-race guard is patched in one client instead of the server**: clipboard delivery exists for a good reason — an IDE user may want the orchestrator in a chat panel (Claude Code, Codex, a right-rail agent) that no terminal can reach, and the orchestrator is a chatting role. But `bootstrap.ts:2527` hands over `'Run /switchboard workflow to start orchestration'`, a slash-command reference that only works where Switchboard's skills are already registered — and it fires precisely when the user has configured no agent CLI, making them the least likely to have them. The VS Code side already builds the portable version. Separately, the create→adopt race that spawns `orchestrator-2` is guarded server-side in standalone (`:2478-2487`) and only client-side in `shell.js`, so an external agent POSTing the extension host's endpoint is unguarded. This subtask fixes both.
- **Two orchestrator entry points are dead or inconsistent, and one concept has four names**: `KanbanProvider:9480`'s `case 'startOrchestrator'` has no sender in any webview, and `switchboard.startOrchestrator` is the only start-agent command in the palette with no equivalent for coder, lead, or intern. Three docblocks and `CLAUDE.md` still assert an AUTOMATION-tab button that does not exist. And one concept carries four names — Operator (`shell.js`), Manage (`implementation.html:1529`), `project_manager` (role key), orchestrator (persona). This subtask deletes the dead doors and settles the vocabulary, recording that `project_manager` is the seat and orchestrator is the persona it adopts.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [There is no way to ask the orchestrator anything from a tracker — add an instructions column whose cards are messages, not work](../plans/orchestrator-instructions-column.md) — **CREATED**
- [ ] [A tracker comment re-dispatches a column agent — retire the per-card trigger that no longer matches how these tools are used](../plans/retire-comment-delta-dispatch.md) — **CREATED**
- [ ] [Remote staging auto-seats the orchestrator, in the one path the code says must hold no judgement — delete the flag, the dead constant, and the stale docblocks](../plans/retire-queue-sequencing-auto-orchestrator.md) — **CREATED**
- [ ] [Two orchestrator entry points are dead or inconsistent, and one concept has four names — delete, and settle the vocabulary](../plans/orchestrator-entry-points-cleanup-and-naming.md) — **CREATED**
- [ ] [The standalone clipboard payload is unusable by the hosts it exists for, and the create-race guard is patched in one client instead of the server](../plans/orchestrator-start-clipboard-payload-and-seat-guard.md) — **CREATED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**One hard ordering constraint:** the instructions column must land **before** the comment-dispatch retirement. Shipping the removal first leaves a window with no remote write channel at all.

Recommended order:

1. **Delete `queueSequencing`.** Independent, and doing it first means the only orchestrator triggers left in the system are deliberate ones — so the instructions column is not confused with the automatic wake it replaces conceptually.
2. **Orchestrator instructions column.** The largest subtask, and the replacement the retirement depends on.
3. **Retire comment-delta dispatch.** Only after 2 is functional.

The other two are independent and can run in parallel with any of the above:

- **Clipboard payload + seat guard** shares no files with the queue path or the instructions column.
- **Entry-point cleanup + naming** is documentation and dead-code removal. It touches the same *concept* as the clipboard plan but not the same code.

**What holds this feature together:** two mechanisms contradict how these tools are actually used. Trackers here are for bulk moves and long-running queues — you check a project while away, advance cards into a column, let the teams drain it. The orchestrator on top of that is a project manager you consult: board organisation, advice on which plans to queue and whether worktrees are needed, pre-flight checks, and a simpler front end than the teams UI for anyone driving everything through an external agentic app. Auto-seating a PM because cards staged, and re-dispatching a coder because someone left a comment, are both the opposite of that.

**Deliberately excluded:** no new automatic orchestrator triggers of any kind; no notification system, because the trackers already have their own and replying onto the originating card is what makes them fire; and no ClickUp comment bus, since building a third implementation of a design being retired is the more expensive mistake.

**One decision left open, not scoped here:** `DEFAULT_REMOTE_CONFIG.mode` is `'ingest'`, so a newly configured tracker gives per-card dispatch rather than the bulk-queue model this feature assumes. Flipping it changes behaviour for existing remote-control users, so the safe form is defaulting only for newly configured trackers and never rewriting an existing stored config. Worth its own plan.

