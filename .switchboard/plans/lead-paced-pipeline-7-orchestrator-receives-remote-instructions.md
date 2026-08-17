# The Orchestrator Is the Inbound Addressee for Remote Control — Instruct the Session, Not Each Agent

## Goal

A remote instruction that is not about one specific card has somewhere to land. The orchestrator receives it, decides what it means, and fans it out to the teams — instead of the user opening each card in Notion and commenting on it to reach each agent individually.

### Problem & background

**Every inbound remote path is card-scoped, so the session has no addressee.**

`RemoteControlService` gives the host exactly two inbound hooks (`src/services/RemoteControlService.ts:99-107`):

* `onColumnMove(plan, targetColumn)` — a remote status change mirrors onto the Kanban column and dispatches that column's agent, the same way a manual drag would;
* `onComment(plan, commentBody)` — "Route an inbound comment to the card's **current column agent**".

Both are keyed to a `KanbanPlanRecord`. The remote workflow documents the consequence as the intended usage: to trigger execution you "set the Linear/Notion status to the execution-trigger state" and to instruct an agent you comment on its card (`.agents/workflows/switchboard-remote.md` §2). Reaching a *different* agent therefore means finding a card that agent owns and commenting there. That is not a habit the user has fallen into — it is the only channel the design offers.

**What has nowhere to go.** Any instruction whose scope is the session rather than a card:

* "start on the auth feature next" — a queue decision, not a card annotation;
* "stop what you're doing" — addressed to everyone;
* "spin up a second team for the API work" — addressed to nobody yet;
* "what's the status?" — a question about the board;
* "skip the third plan in the queue" — about the queue, which is not a card.

With two teams live it is worse than awkward: there is no card whose column identifies *which team* should act, so column-based routing cannot express the instruction even in principle.

### Root cause — the remote channel was modelled as per-card annotation

Per-card annotation is exactly right for "improve this plan" or "this review missed something" — the card is the subject, and the column identifies who should read it. It is the wrong model for "run my night", where the subject is the session. The channel was built for the first case and there has never been a second one, so session-scoped intent has been decomposed by hand into per-card comments by the user.

### The two remote shapes are not the same problem

* **Notion / Linear** — there is no agent on the remote side. Prose arrives and something local must interpret it. That interpreter is the orchestrator, and this is the case that is currently impossible rather than merely clumsy.
* **Claude Code Remote** — there *is* an agent on the remote side, and it can drive the LocalApiServer directly. It does not need an interpreter; it needs a local peer that holds session context across its turns and can coordinate several teams on its behalf. Same endpoint, more capable caller.

Both are served by one inbound route. The difference is only how much interpretation the message needs.

### Why this needs no new clock

A message delivered to an idle agent terminal *is* a turn (`switchboard-contracts` #9). A seated, idle orchestrator therefore costs nothing until an instruction arrives, and each instruction is one turn. There is no wake interval and nothing to poll locally.

**Being precise about the one timer that does exist:** `RemoteControlService` polls the provider every 30–120s and its header states plainly that this is polling, not webhooks. That timer is **inbound transport** and is out of scope for the clock retirement in subtask 4 — which deletes *pacing* clocks. Nobody should read that plan as "no timers survive anywhere".

### Relationship to the handoff plan

Subtask 6 makes the orchestrator exit after handoff and argues that "an idle-but-seated orchestrator is a resident manager with extra steps". Remote Control is the exception, and the distinction is real rather than a carve-out: **seated-idle-woken-by-inbound-push is not armed-on-a-clock.** Subtask 6's arm path installs a wake interval; this one installs nothing and consumes nothing between instructions. Subtask 6 is amended by this plan to name a third session state rather than being contradicted by it.

---

## Metadata

- **Complexity:** 5
- **Tags:** backend, api, feature, reliability
- **Feature:** 3e8b662b-a8a8-42c5-8e43-6d67998aa201

---

## User Review Required

**One decision worth a look, flagged rather than assumed:**

* **The inbound channel is a conventionally-named control card on the remote board**, not a second transport. Everything hard about remote ingest already exists and is load-bearing: the two-cursor delta polling, the `authoredBySelf` skip, the processed-comment-id set that de-dups Notion's minute-rounded `created_time`, and the cursor-advances-after-dispatch ordering. A parallel inbound path would have to reimplement all four guards, and the header comment records that each was added for a specific observed failure. Riding the existing stream costs one branch in `onComment`. The alternative — a provider-level channel outside the card model — is cleaner conceptually and considerably more work; if you want that instead, say so before this is coded.

Four decisions made:

* **No orchestrator seated ⇒ reply on the card saying so.** Silently dropping an instruction is the inbox-with-no-trigger failure the retired orchestrator machinery already shipped once.
* **The orchestrator does not exit while Remote Control is active** — subtask 6's exit rule gains this exception explicitly.
* **Replies go out through the existing `/comment` bridge**, already documented by the `notion-api` skill. No new outbound path.
* **Instructions are interpreted, not executed literally.** The orchestrator decides what a prose instruction means for the board and says what it did; it is an addressee, not a command parser.

---

## Implementation

**Blocked on subtask 6** — this amends the session states that plan defines.

1. **Control card convention.** One card per remote board, identified by a stable convention (a reserved title, or a flag on the card record). Comments on it are session-scoped instructions. It is not a plan and must be excluded from the ready set (subtask 5) and from the queue (subtask 2), or it will be dispatched as work.

2. **Branch in `onComment`.** If the plan is the control card, deliver the body to the orchestrator terminal via `ptySendPrompt` with `clearBeforePrompt: false` — the orchestrator's session context across instructions is the entire point, and the default would wipe it. Otherwise, existing per-card behaviour, untouched.

3. **No orchestrator seated.** Post a reply on the control card naming that no orchestrator is running and how to start one. Do not queue the instruction for later delivery — a stored instruction with no reader is the failure mode being avoided, not a mitigation of it.

4. **Persona `## Remote Control`.** You are the inbound addressee for this session: instructions arrive as turns, you interpret them against board state, you act by messaging leads and calling the board API, and you reply on the control card with what you did. You do not exit while Remote Control is active. Bounded reply shape, per subtask 5's ceiling discipline — a Notion comment is a worse place for an essay than a terminal is.

5. **Cross-team fan-out.** With multiple teams live, the orchestrator resolves which team an instruction concerns and messages that lead via `ptySendPrompt`. This is the coordination case that column routing cannot express and is the substance of "could run multiple teams".

6. **Session state.** Amend subtask 6: `handed off` (exited), `armed` (multi-team, wake interval), and `seated` (Remote Control — idle, no timer, woken by inbound instructions). Handoff must refuse to exit while Remote Control is active.

---

## Verification Plan

- **Unit:** a comment on the control card reaches the orchestrator terminal with `clearBeforePrompt: false`; a comment on an ordinary card still reaches that card's column agent unchanged.
- **Unit:** control-card comment with no orchestrator seated posts an explanatory reply and delivers nothing.
- **Unit — the runaway guard:** the orchestrator's own reply, posted through `/comment` onto the control card, must NOT re-ingest as an instruction on the next poll. `authoredBySelf` (Linear marker / Notion `created_by` = bot) covers this, but it needs an explicit test: a self-feeding orchestrator on a 30-second poll is a runaway loop, and this is the single most dangerous failure this plan can introduce.
- **Unit:** the control card is absent from the ready set and from the queue.
- **Unit:** handoff refuses to exit while Remote Control is active.
- **Manual UAT — Notion:** with one team running a queue, comment "skip the next plan and start on the auth feature" on the control card. The orchestrator should reorder the queue, say so in a reply, and the lead should pick up the right card next.
- **Manual UAT — multi-team:** two teams live, instruct one of them by name from Notion, and confirm only that lead is messaged.
- **Manual UAT — Claude Code Remote:** the remote session drives the same endpoint directly and coordinates two teams without the comment bridge.
- **Regression:** existing per-card remote comment routing and status-change dispatch behave exactly as before; the two cursors, the seen-set and the echo guards are untouched.
