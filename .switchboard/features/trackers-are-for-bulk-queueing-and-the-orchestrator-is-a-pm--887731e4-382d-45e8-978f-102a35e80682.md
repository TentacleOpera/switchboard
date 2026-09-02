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
- [ ] [There is no way to ask the orchestrator anything from a tracker — add an instructions column whose cards are messages, not work](../plans/orchestrator-instructions-column.md) — **CREATED** — ID: 70068478-b145-4dc3-80b4-db3c272cd4ad
- [ ] [A tracker comment re-dispatches a column agent — retire the per-card trigger that no longer matches how these tools are used](../plans/retire-comment-delta-dispatch.md) — **CREATED** — ID: cb56edae-72f5-4f9d-af8b-2398454f5dde
- [ ] [Remote staging auto-seats the orchestrator, in the one path the code says must hold no judgement — delete the flag, the dead constant, and the stale docblocks](../plans/retire-queue-sequencing-auto-orchestrator.md) — **CREATED** — ID: bc38bc9f-8bbb-4182-9274-dc100ffe35d5
- [ ] [Two orchestrator entry points are dead or inconsistent, and one concept has four names — delete, and settle the vocabulary](../plans/orchestrator-entry-points-cleanup-and-naming.md) — **CREATED** — ID: 2e684007-a9e5-41af-8534-99ca73df2e95
- [ ] [The standalone clipboard payload is unusable by the hosts it exists for, and the create-race guard is patched in one client instead of the server](../plans/orchestrator-start-clipboard-payload-and-seat-guard.md) — **CREATED** — ID: aa726321-f524-490b-a689-3a9f505ab650
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

**Additional ordering constraint (from reconciliation audit):** the entry-point cleanup + naming subtask should land **last**, after all other subtasks. It settles the vocabulary ("Mission Control" as the primary name) that the other subtasks' code changes should follow. Landing it first and then having later subtasks reference the old name in their diffs creates confusion; landing it last means the other subtasks have already made their code changes using the current names, and this subtask cleans up the remaining stragglers.

## Team Dispatch Instructions

### Remote staging auto-seats the orchestrator, in the one path the code says must hold no judgement — delete the flag, the dead constant, and the stale docblocks
- **Seat:** Intern
- **Acceptance:**
  - Staging cards via the remote path creates no Mission Control terminal.
  - `queue/next` still drains staged cards in `queue_position` order, unchanged.
  - Legacy config blob with `queueSequencing: true` plus an unknown sibling key loads without crash; the sibling survives a write.
  - `onArmQueueWatch` still fires when cards are staged (`_stagedThisCycle` preserved).
  - Both `#remote-queue-sequencing` (connections.js) and `#linear-queue-sequencing` (linear.html) checkboxes are gone.
- **Must not touch:** `startMissionControlFromKanban`, `POST /mission-control/start` route, `onStageForQueue`, `onArmQueueWatch`, `_stagedThisCycle`.

### There is no way to ask the orchestrator anything from a tracker — add an instructions column whose cards are messages, not work
- **Seat:** Coder
- **Acceptance:**
  - A note in the instructions column on each provider (Notion, Linear, ClickUp) reaches Mission Control and the reply appears on the originating card.
  - No plan file is written, no queue position assigned, no coder dispatched for an instructions card.
  - With no Mission Control running, the reply says so and no terminal is created.
  - Multiple poll cycles over an answered card produce exactly one reply (seen-set + `authoredBySelf` guards).
  - An instructions card cannot resolve to a queueable column (`QUEUEABLE_TARGET_COLUMNS` exclusion verified).
- **Must not touch:** `fetchStateDeltas`, `stateKeyToColumn`, `postManagedComment`, `updateIssueDescription`, the provider factory — these are reused, not modified.

### A tracker comment re-dispatches a column agent — retire the per-card trigger that no longer matches how these tools are used
- **Seat:** Intern
- **Acceptance:**
  - A comment on a tracked Linear or Notion card dispatches no agent and creates no terminal.
  - Column-move dispatch still fires (`_remoteDispatchColumnAgent` from the column-move path at `:3486` and `:3569`).
  - If the poll is removed, nothing reads `remote.commentCursor.*` or `remote.commentSeen.*`.
  - Legacy config with `comments: true` and an unknown sibling loads without crash; the sibling survives a write.
  - The instructions column is functional before this lands.
- **Must not touch:** `_remoteDispatchColumnAgent` method itself (only its caller in `_remoteDispatchComment` goes), `authoredBySelf` guard logic, the seen-set infrastructure.

### The standalone clipboard payload is unusable by the hosts it exists for, and the create-race guard is patched in one client instead of the server
- **Seat:** Coder
- **Acceptance:**
  - With no agent CLI configured, the clipboard prompt names a file to read and pins the workspace root — paste it into an agent with no Switchboard skills and it reaches the entry protocol.
  - The pasted prompt uses the pinned root, not the agent's working directory.
  - POST `/mission-control/start` twice in rapid succession against the extension host (without going through shell.js) produces exactly one Mission Control terminal and no `mission-control-2`.
  - With a live seated Mission Control, POST start again redelivers the persona prompt and returns `mode: 'terminal'`.
  - A dead seat (recorded but terminal killed) recovers — POST start creates a fresh terminal rather than returning an error.
- **Must not touch:** `startMissionControlFromKanban` behaviour (add the guard at the seam, not inside the method), `MISSION_CONTROL_TERMINAL_NAME` (must stay imported from `autobanState.ts`), shell.js's button-disable pattern.

### Two orchestrator entry points are dead or inconsistent, and one concept has four names — delete, and settle the vocabulary
- **Seat:** Intern
- **Acceptance:**
  - `POST /mission-control/start`, the shell rail icon, and implementation.html's Manage button all still work.
  - `switchboard.startOrchestrator` is gone from the palette and from `package.json`; `autoban-state-regression.test.js` passes after its command assertions are removed.
  - `startOrchestrator` and `stopOrchestrator` appear in neither the KanbanProvider handler nor the generated verb allowlist.
  - No docblock in `TaskViewerProvider.ts` or `LocalApiServer.ts` claims an AUTOMATION-tab caller.
  - `CLAUDE.md` and `AGENTS.md` reference `switchboard-mission-control` (not `switchboard-orchestrator`) and name the three real entry points.
- **Must not touch:** `startMissionControlFromKanban`, `POST /mission-control/start` route, `MISSION_CONTROL_TERMINAL_NAME`, the `project_manager` and `mission-control` role keys (document the relationship, do not merge).

