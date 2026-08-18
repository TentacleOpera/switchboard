# Team Work Queue: Queue Work to a Team Instead of Dispatching One Prompt at a Time

## Goal
Give each team a durable, visible queue of pending work. An operator drops plans, cards, or ad-hoc prompts onto a team; the queue holds them; items are handed to the head (or fanned out to members) as capacity frees up. Today every dispatch is a single fire-and-forget prompt with nowhere to put the next one.

### The problem, and the root cause
There is no queue anywhere in the terminals surface. Every use of the word "queue" in `src/webview/terminals.js` refers to **byte-level plumbing** — the xterm write batch queue, the WebSocket paste backpressure chip (`queuedBytes`, `terminals.js:3913`), the input throttle. Nothing queues *work*.

Dispatch is immediate and single-shot. `dispatchInFlight` (`terminals.js:191`) is a per-terminal counter of in-flight `ptySendPrompt` requests, deliberately a count rather than a boolean because `withTerminalLock` serialises concurrent sends — so the system knows a send is in progress but has no concept of a send that is *waiting*. Drag a card onto a busy terminal and you get a second prompt pasted into an agent mid-task.

The consequence for teams is the one that hurts: the operator becomes the scheduler. They must watch for a team to finish, then hand it the next thing, then watch again. That is precisely the babysitting the orchestrator persona exists to avoid — but the orchestrator is an unattended batch manager launched from the AUTOMATION tab, all-or-nothing. There is no middle ground where the operator stacks up five plans for one team and lets it work through them.

### The primitive that already exists, unused
`ScheduledJobsService.ts` contains a complete file-based work-inbox implementation with **no callers outside its own module**:
- `bootstrapInstructionsDirectory` (`src/services/ScheduledJobsService.ts:41`) creates `.switchboard/instructions/inbox/`, `inbox/claimed/`, `standing/`, `moves/`.
- `writeInboxFile` (`ScheduledJobsService.ts:65`) writes an item with `{ flag: 'wx' }` exclusive-create and retries up to 5 times on a same-second filename collision — the comment records that the previous plain `writeFile` silently clobbered collisions and lost reports.
- `claimInboxItemIn` / `isInboxItemClaimedIn` (`ScheduledJobsService.ts:158`, `:128`) implement claim-with-staleness via `<filename>.claim` sidecars carrying `claimed_ts`, with a 24-hour default staleness so an abandoned claim reverts.

That is the hard part of a queue — durable enqueue, exactly-once claim, crash recovery — already written and tested-shaped. Build on it rather than inventing a parallel mechanism in webview state, which would evaporate on reload.

## Metadata
- **Complexity:** 8
- **Tags:** backend, frontend, api, feature, reliability

## Dependencies
- **Team identity foundation** — the queue is keyed per team.
- **Team cockpit** — where the queue is displayed and managed.

## Approach

### 1. Storage: one inbox per team, on the existing primitive
`.switchboard/teams/<groupId>/queue/` with a `claimed/` subdirectory, created via the same `bootstrapInstructionsDirectory` shape. Reuse `writeInboxFile`, `claimInboxItemIn` and `isInboxItemClaimedIn` by passing the team directory as `dirAbs` — all three are already directory-parameterised for exactly this kind of reuse (`ScheduledJobsService.ts:65` says so explicitly).

Each item is a markdown file with frontmatter: `kind` (`plan` | `prompt` | `card`), `planId`, `feature`, `enqueued_ts`, `target` (`head` | `any-member` | a specific member name), `priority`. Body is the prompt or a plan reference.

Files, not a DB table, for three reasons: the primitive above is file-based; a queue survives an extension crash and a workspace reload without migration concerns; and an operator (or an agent) can inspect and hand-edit it. Given ~4,000 installs on mixed versions, adding a directory is also the lowest-risk storage change available — nothing to migrate, and an older build simply ignores it.

### 2. API
- `GET /terminals/teams/<groupId>/queue` — list items with claim state.
- `POST /terminals/teams/<groupId>/queue` — enqueue `{ kind, body, planId?, target?, priority? }`.
- `POST /terminals/teams/<groupId>/queue/<id>/claim` — claim, honouring staleness.
- `DELETE /terminals/teams/<groupId>/queue/<id>` — drop an item.
- `POST /terminals/teams/<groupId>/queue/reorder` — set explicit order.

Validate `groupId` against the registered groups before touching the filesystem, and reject any id that is not a plain slug — these paths are interpolated into a filesystem path, so the traversal guard must be as strict as the one in `_handleServeStatic` (`LocalApiServer.ts:906`). Never accept a caller-supplied path fragment.

### 3. The pump
A single dispatch loop, host-side, per team:
1. Is the target idle? Idle means: terminal active, no `dispatchInFlight` entry, and no unacknowledged in-progress marker.
2. If idle, claim the next item and deliver it via the existing `ptySendPrompt` path — reusing `withTerminalLock` and the standing-orders application, so a queued prompt is indistinguishable from a hand-dispatched one at the agent's end.
3. On the member's completion callback, release the claim, mark done, and pump again.

Completion detection must reuse what the system already treats as truth. Per the contracts skill, completion is the **plan-file mtime advance** and the existing `agentCompleted` / badge signal (`terminals.js:1082`) — do not invent a new heuristic like output quiescence. If a signal never arrives, the 24-hour claim staleness is the backstop, and the queue shows the item as stalled rather than silently stuck.

**The pump must be explicitly opt-in per team**, defaulting to manual. An operator who queues five plans and did not expect autonomous dispatch has just had five agents started without asking. Manual mode shows the queue with a per-item "send now"; auto mode pumps. This is the single most important product decision in the plan.

### 4. UI in the team cockpit
- Queue list: position, kind, title, target, state (pending / claimed / running / done / stalled).
- Drag to reorder; drag out or an immediate delete to remove — no confirm gate.
- "Send next now" and a mode toggle (manual / auto).
- Enqueue by dropping a kanban card onto the team. The kanban pane already has drag-to-terminal dispatch (`terminals-kanban-pane-drag-to-terminal-dispatch` shipped); extend the same drop target to accept a team as a destination rather than building a second drag system.
- Show the queue depth on the team's rail icon badge, so depth is visible without opening the cockpit.

### 5. Do not fight the orchestrator
The orchestrator persona already dispatches unattended and moves cards via `move-card.js` / `POST /kanban/move` (never SQL). A team queue running in auto mode alongside an active orchestrator would double-dispatch the same plans. Detect an active orchestrator and refuse to enable auto mode with a message naming the conflict, or scope auto mode to teams the orchestrator is not managing. Decide this before building the pump, not after.

## Edge cases
- **Enqueued plan already coded/moved.** Re-check the card's column at claim time, not at enqueue time. A plan that moved on is skipped with a visible reason, not dispatched into a stale state.
- **Target member dies mid-item.** The claim goes stale, the item returns to pending. Do not auto-retry immediately — a crash loop would burn the whole queue. One automatic requeue, then mark stalled.
- **Team closed with a non-empty queue.** The queue persists on disk and is there when the team restarts. Say so in the UI; do not silently discard.
- **Two cockpit windows on one team.** Both pump. The `wx` exclusive-create claim is the arbiter — this is exactly what it was written for. Verify two concurrent claims of one item yield one winner.
- **Item body larger than a paste can carry.** The image paste path caps at 4 MB with a documented reason (`terminals.js:7711`); prompts have practical CLI limits too. Cap item bodies and reject at enqueue with a clear error rather than truncating at dispatch.
- **Claim sidecar unparseable.** `isInboxItemClaimedIn` already treats a parse failure as unclaimed (`ScheduledJobsService.ts:145`). Keep that behaviour — biasing toward re-dispatch beats a permanently wedged item.
- **`.switchboard/` absent.** `bootstrapInstructionsDirectory` returns `null` rather than creating it (`ScheduledJobsService.ts:47`) so non-Switchboard workspaces are not polluted. Match that: no `.switchboard/`, no queue, feature disabled with a reason.

## Verification Plan
1. `npm run compile` — clean.
2. Unit: enqueue → list → claim → complete → list, with correct state at each step.
3. Unit: two concurrent claims of one item — exactly one succeeds (pins the `wx` guarantee).
4. Unit: a claim older than the staleness window is reclaimable; a fresh one is not.
5. Unit: same-second enqueue collisions retry and both items survive (pins the collision retry the module documents).
6. **Security unit:** `groupId` and item id containing `../`, absolute paths, or URL-encoded traversal are rejected before any filesystem call. Assert no file is created outside the team directory.
7. Unit: the pump does not dispatch to a terminal with a `dispatchInFlight` entry.
8. Unit: manual mode never dispatches without an explicit action — assert across a full pump cycle with items pending.
9. Manual, installed VSIX: queue three plans to a team in manual mode. Nothing is sent. "Send next" sends exactly one. Completion does not auto-send the second.
10. Manual: switch to auto. The remaining two work through one at a time, each waiting for the prior completion.
11. Manual: kill the team mid-item. Confirm the item returns to pending, then stalls after one requeue rather than looping.
12. Manual: reload the window with a non-empty queue — the queue is intact and correctly ordered.
13. Manual: enable auto with the orchestrator running — confirm the conflict is refused with a clear message and nothing double-dispatches.
14. Manual: drop a kanban card onto a team icon; confirm it enqueues rather than dispatching immediately, and that plain terminal drops still dispatch as they do today.
