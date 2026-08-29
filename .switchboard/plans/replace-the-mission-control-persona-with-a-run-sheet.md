# Replace the Mission Control persona with a run sheet that asks what you want and loads only that protocol

## Goal

Turn `/switchboard` step 2 from "become an unattended overnight dispatcher" into "ask the operator
which job they want, then load the protocol for that job." The 619-line document is not shortened —
it is decomposed, and each part becomes the protocol for one branch, loaded only when that branch is
chosen. An entry appears in the menu when its job exists; nothing waits on a job that does not.

### Problem Analysis

**Every entry pays for one job.** `buildMissionControlKickoffPrompt` (`TaskViewerProvider.ts:11728`)
concatenates a runsheet plus the whole 619-line `switchboard-mission-control/SKILL.md` and returns it
for **all three** modes. So typing `/switchboard` to ask "what's ready?" delivers the full overnight
tick protocol — stall counters, wake semantics, merge-back, silent-when-idle — before the operator has
said what they want.

**And it is the wrong job.** `the-automation-model-four-things-not-a-mode-axis.md` splits Mission
Control in two: **unattended** ("sequential mission queuing… **no persona**") and **operations**
("complex runs needing active planning and oversight… **the persona**"). The 619 lines are written
for the unattended flavour — the one the model says needs no persona — with 24 lines of
overnight/wake framing. The operations flavour, which is what a persona is for, is barely present.

**The organising noun is absent.** "mission" appears 23 times in the document and every single
occurrence is a path fragment or config key (`.switchboard/mission-control/session.md`,
`missionControlArmed`, `GET /mission-control/session-log`). Never once as a unit of work. Both
flavours are "bound by the mission's membership"; the persona operating them has never heard of one.

**Why the persona shape is wrong in the first place.** The launcher already declares itself *"a
launcher, not a console"* and closes by pointing at the skills that own each concern. `.agents/` holds
32 protocols and 7 skills that already own planning, features, board reads, card moves, worktrees and
the HTTP contract. The persona restates their content instead of pointing at them, so it must be kept
in sync with all of them — and it is not: `rename-the-orchestrator-to-mission-control.md` moved the
endpoints and the launcher still names `/orchestration/confirm`, a route that does not exist. A
pointer cannot rot the way a copy does.

**The liveness ceremony discards the answer it asked for.** `GET /health` is not a bare probe — it
returns `{ service, status, port, pid, roots, terminals, terminalCount, selectedWorkspaceRoot }`
(`LocalApiServer.ts`, the `/health` branch). The protocol calls it with
`curl -s -o /dev/null -w '%{http_code}'` — **discarding the body and keeping the status code** — and
pastes that four-line preamble **four times** in the 619-line document and twice more in the launcher.
Three costs, all avoidable by dropping one flag:

- **The misdiagnosis warning exists only because of it.** `## Port Discovery` spends a paragraph on
  *"Never report an empty fleet, an empty board, or a missing team off a resolve that never got a
  200."* That conflation is possible only when the agent holds a bare status code and must *remember*
  the distinction. Reading the body makes it structural: no response is down, `terminals: []` is
  up-with-nothing-seated. The rule stops needing to be stated.
- **`roots` and `selectedWorkspaceRoot` answer the question the section raises and then drops.** It
  correctly warns that *"every workspace's port file holds the same port, so its presence proves
  nothing about this workspace"* — and then throws away the two fields that settle exactly that. A
  200 cannot tell you it is *your* board; the body can.
- **Pre-flight check 1 needs this data anyway.** "Is there a coding team, not merely a coding agent?"
  requires the terminal roster, which is already in the response the agent just made and binned.

**The one case that genuinely needs resident instructions.** Under `## Context Is Cleared Every Tick`,
every wake starts from a cleared terminal. On tick 40 there is no operator to ask, so the tick's rules
must be in the prompt. That is an argument for the *armed* branch carrying its protocol resident — not
for every entry carrying it.

### Two entities, and the launcher currently conflates them

The **mission controller** and the **`/switchboard` agent** are separate, and only one of them is a
seat:

| | mission controller | `/switchboard` agent |
| :--- | :--- | :--- |
| what it is | a seated terminal supervising an attended mission | the conversational front door |
| how it is woken | mission transition points (`supervised-missions-wake-the-controller-on-transitions.md`) | its own host scheduler, after it dispatches |
| replaceable? | **no** — an attended mission requires the controller seated | n/a |
| needs an interval tick? | no | yes, but not one Switchboard builds |
| project management via | buttons in the `#agent-dock` header | the run sheet's menu |

**Step 2 inverts this today.** `.agents/workflows/switchboard.md` says *"**You are the orchestrator.
Not a terminal you start — this one.** Adopt the seat and run the pre-flight here, in this
conversation"*, and then forbids the alternative: *"Never call `POST /orchestration/start` from here —
that door creates a separate Orchestrator terminal, which is the opposite of what `/switchboard` is
for."* So the launcher makes the front-door conversation *become* the controller and rules out seating
one. For an attended mission that is backwards: the controller must be a seated terminal, and the
`/switchboard` agent is the thing that starts it.

**Consequence: the run sheet does not adopt.** The step-2 rewrite drops the adopt call and the "you
are the orchestrator" framing. Seating a controller becomes one of the menu's branches — something the
agent *starts* when an attended mission needs one — not what the agent silently becomes on arrival.

### A menu is what you use when there is no UI

The controller needs the same project-management reach as the `/switchboard` agent — grouping plans,
improving a plan, arranging features, reading the board. But it should not get there through a menu
prompt, because **the controller has a UI and the `/switchboard` agent does not.** That is the whole
difference, and it decides the affordance:

| | affordance | why |
| :--- | :--- | :--- |
| `/switchboard` agent | the run sheet's menu | a conversation with no surface to click |
| mission controller | buttons in the `#agent-dock` header | it runs in an expanding shell panel that can render controls |

A menu prompt is a **substitute for buttons**, not a superior form of them. Where a UI exists, buttons
win on every axis that matters here: they cost no resident context, they need no parsing, they cannot
be misread, and they can be stateful — disabled when the action does not apply, which a menu line
cannot be.

**The dock is already there, and it is a shell surface — not the Mission Control panel.** `#agent-dock`
(`shell.html:440`, `shell.js:20-33`) is a right-hand flex child beside `#content` that hosts one live
terminal via `/terminals?solo=&dock=1`, with its own splitter, header, role picker and close button.
It expands and collapses; it is not a tab inside the panel. (The panel has its own separate embed,
`mc-controller-strip` / `mc-controller-frame` at `mission-control.js:393-407` — a different surface,
and not the one this section is about.)

Its header carries **three** controls today — `dock-role-btn` (the one `.dock-chip`), `dock-title`,
and `dock-close`, plus `dock-start` in the empty state (`shell.html:615-624`). No project-management
controls exist there.

And the dock already opens on the right role: `dockRole` defaults to **`'project_manager'`**
(`shell.js:60`). So these are not new controls bolted to a foreign surface — they are the controls
that role has been missing, on the panel that already exists to host it.

**And the mechanism is the house pattern.** Switchboard already generates prompts from buttons —
`refine_ticket` and `refine_feature` are described in `CLAUDE.md` as backend-consumed skills fired
when *"User clicks Refine… to copy a prompt"*, and *Suggest Features* sources `group-into-features` the
same way. The only change for the controller is the delivery: `ptySendPrompt` into the seated terminal
rather than the clipboard. No new machinery, and no second definition of what each action means — the
button and the menu entry name the same protocol.

**Consequence for this plan.** The menu is scoped to the `/switchboard` agent. The controller's branch
of the run sheet says what the controller *is* and how it is woken, and points at the dock for
everything else; it does not restate the project-management actions as menu lines. Two surfaces, one
set of protocols, each reached the way its host allows.

### The tick belongs to the agent's host, not to Switchboard

The `/switchboard` agent does need periodic reminding — to read terminal statuses and the inbox after
it dispatches. It does **not** need Switchboard to build that. Any host worth running `/switchboard`
in has its own scheduling tool, so the run sheet's instruction is one line: *after dispatching,
schedule a wake ~2 minutes out to check the progress of that dispatch.*

That deletes an apparatus rather than relocating it. The `-external` runsheet (84 lines) exists almost
entirely to make an agent self-wake — *"You MUST start the self-wake loop before your first tick, or
the session dies on arrival"* — and the shared logic's tick, silent-when-idle and `progress.json`
stall counters are the interval machinery around it. A host-scheduled check after a dispatch replaces
the reason all of it exists.

**Where the stall case lands.** A dispatch that goes quiet produces no mission transition, so nothing
wakes on it. That is exactly what the agent's own scheduled check is for: it dispatched, so it is the
one that should come back and look. Stall detection stops being a background counter and becomes a
consequence of having dispatched.

**Hosts without a scheduler.** This rests on the premise that the host has one. Where it does not, the
correct behaviour is to say so and let the operator check back — not to reintroduce a self-wake loop.
Recorded as a stated assumption rather than a silent one.

### Root Cause

The document was written when the only job was an overnight batch run, and the entry point was a
button that started one. `/switchboard` was added later as a second door onto the same prompt, and the
prompt was never given a way to ask what the operator came for.

### Non-goals

- **Not shortening the 619 lines.** They are re-homed, not cut. A branch that needs the tick protocol
  gets all of it.
- **Not building missions.** The menu lists jobs that exist and gains an entry when one ships. This
  plan removes the dependency rather than satisfying it.
- **Not a mode.** See the caution in change 2.
- **Not the three front-door defects** — those are
  `the-mission-control-front-door-delivers-twice-and-lies-about-the-posture.md`, which must ship
  first (see Dependencies).

## Metadata

**Complexity:** 6
**Tags:** refactor, ux, docs, reliability
**Feature:** 73ebf150-50f9-4e8f-b9db-58af49202c6a

## Dependencies

- **The front-door plan ships first.** It repairs `POST /orchestration/confirm` →
  `/mission-control/confirm` and the two legacy `.switchboard/orchestrator/` paths. Building a menu on
  top of a step 2 that cannot arm would bury the broken call one level deeper.
- **Teams remain unreadable over HTTP.** There is no `GET /teams` — only `/teams/create-external` —
  which is the subject of `mission-control-cannot-see-teams-over-http.md`
  (*"Mission Control cannot see teams over HTTP, so it cannot answer its own pre-flight"*). So the
  orientation call in change 4 can distinguish *board down* from *nothing seated*, but not *team* from
  *lone agent*. Pre-flight check 1 stays partially unanswerable until that plan lands; this plan must
  not pretend otherwise.
- Its posture fix (`ATTENDED=true` on interview) is also assumed here: a run sheet whose first act is
  to ask is attended by construction, and the flag must agree.

## Proposed Changes

1. **Write `.agents/protocols/switchboard-mission-control-runsheet/SKILL.md`** — the menu. Target
   40–60 lines. It states the two-line role, resolves the port once (`## Port Discovery`), asks the
   operator which job they want, and names the protocol path for each. It executes nothing itself.

2. **The menu asks; it does not persist.** The answer selects what to load for this session and is not
   written to config. `the-automation-model-four-things-not-a-mode-axis.md` spends its length removing
   an exclusive automation radio; a menu that stores a mode rebuilds it in a new place.

3. **Decompose the 619 lines into branch protocols.** Content moves verbatim where it can; the section
   sizes below are today's:

   | branch | protocol content | lines |
   | :--- | :--- | :--- |
   | *(always)* | Role & Scope, Hard Rules, orientation call (Port Discovery, shrunk per change 4) | <57 |
   | What's ready / board state | `## What Is Ready To Go` | 72 |
   | Run a batch now | Pre-flight, Handoff-or-arm, The handoff sequence | 154 |
   | Check a dispatch (host-scheduled) | Signals, Verify via Git, Messaging Leads — **without** The Tick or Context Is Cleared, which exist for an interval loop that no longer runs | ~130 of 228 |
   | Seat a controller | starting a controller terminal for an attended mission | new, small |
   | Merge a finished feature | Merge-Back | 22 |
   | Remote batch | Remote intake | 19 |
   | *(reference)* | Transitions You Own, What You Never Do, Session File/Log/Completion | 50 |

   `switchboard-mission-control-http` (364) and `switchboard-contracts` (127) stay where they are and
   are named by the branches that need them, not inlined.

4. **Make the resolve an orientation step, not a ceremony.** Replace the repeated
   `-o /dev/null -w '%{http_code}'` probe with a single call that **keeps the body**, and fold it into
   the always-on preamble once instead of pasting it per snippet. The agent reads `terminals` /
   `terminalCount` (the roster it needs regardless), `roots` and `selectedWorkspaceRoot` (whether this
   is the board for *this* workspace), and treats absence of a response — not an empty array — as
   "board is down".

   Delete the "never report an empty fleet" paragraph rather than rewording it: with the body in hand
   the error it guards against cannot be made. A rule that is unnecessary is better than a rule that
   is stated well.

   **Keep step 1's probe separate.** In the launcher, the check runs *before* any real work because it
   decides whether to spawn `npx switchboard`; there is no call to fold it into. Read the body there
   too — `roots` tells the fail-safe branch whether the live server actually serves this workspace,
   which it currently guesses at — but leave it as its own step.

5. **Assemble per mode in `buildMissionControlKickoffPrompt`.** Replace the single concatenation with
   a mode-keyed one:

   | mode | receives |
   | :--- | :--- |
   | `interview` | runsheet (menu) + always-on preamble. **Not** the tick protocol. |
   | `stale-session` | the same, plus the existing stale-file instruction |
   | `resume` | the *check a dispatch* protocol — the agent woke itself on its own schedule to look at what it dispatched. No menu: it already knows why it is here |

   The three-way branch already exists at `:11769-11783`; this keys the document to it rather than
   only the closing instruction.

6. **Rewrite launcher step 2** to hand off to the run sheet rather than to a persona. It stops saying
   "become the orchestrator" — a phrase that predates the rename and describes a role the design
   deliberately does not have (see `rename-the-orchestrator-to-mission-control.md`: *"the design is a
   monitor with escalation rights and no dispatch authority"*). Edit `.agents/workflows/switchboard.md`;
   `.claude/skills/switchboard/SKILL.md` is generated from it.

7. **Keep the menu honest by construction.** Every entry names a protocol path. A menu entry whose
   protocol is missing is worse than no entry — it is the `/orchestration/confirm` failure again, in a
   new file. Verification 2 asserts existence; change 8 keeps verbs out of the menu entirely.

8. **Leave the `no-persona` branch alone.** Its stand-by message is correct.

9. **Name protocols, not verbs.** The menu points at protocol files; `GET /catalog` and
   `switchboard-orchestration` remain the source of truth for endpoints and payloads. This is the rule
   that stops the run sheet re-accreting into a second persona: a menu entry may name a file, never
   restate an endpoint.

## Verification Plan

1. **The interview prompt does not carry the tick protocol.** Assert the `interview` prompt contains
   the menu's heading and **not** `## The Tick`, `## Merge-Back`, or `stallCount`. This is the whole
   point of the plan and the assertion that fails if change 4 regresses.
2. **Every protocol the menu names exists on disk.** Walk the run sheet, extract every
   `.agents/protocols/...` and `.agents/skills/...` path, and assert each resolves. A path-existence
   test, not a spelling one — the launcher's dead endpoint is this exact failure in another file.
3. **The armed branch still gets everything it needs.** Assert the `resume` prompt contains `## The
   Tick`, `## Signals`, `## Verify via Git`, and the `progress.json` stall-counter contract. Clearing
   context makes any omission here a silent behaviour loss, not a visible one.
4. **The armed branch carries no menu.** Assert the `resume` prompt contains no menu heading and no
   "ask the operator" instruction — there is nobody to ask on tick 40.
5. **No content was lost in the decomposition.** Assert the union of the branch protocols plus the
   always-on preamble covers every `##` section of today's 619-line file, by heading. A section that
   belongs to no branch is a section that has been silently deleted.
6. **Nothing is persisted.** Assert no config key is written when the operator picks a job, and that
   two consecutive `/switchboard` sessions can pick different jobs with no carry-over.
7. **The menu size holds.** Assert the run sheet is under 80 lines. It exists because the 619 was
   unconditional; a run sheet that grows into a second persona has failed, and only a bound catches
   that.
8. **The menu states no endpoints.** Assert the only endpoint named anywhere in the run sheet is the
   single `GET /health` orientation call from change 4 — no `POST /` at all, and no other `GET /`.
   This is change 9 made enforceable, and it is why change 4 folds the resolve into the preamble
   rather than leaving it inline per branch.
9. **Launcher and mirror agree.** Assert `.claude/skills/switchboard/SKILL.md` matches
   `.agents/workflows/switchboard.md` modulo frontmatter.
10. **Both hosts.** All extension call sites and the three in `src/standalone/bootstrap.ts` share the
    builder, so assemble-per-mode is tested by calling the builder directly, host-agnostically. Note
    standalone passes no `deliveryMode` and therefore always receives the internal runsheet — carried
    forward as-is by this plan and recorded as a question, not fixed here.

11. **The body is read, not discarded.** Assert no `-o /dev/null` appears in the run sheet, the
    branch protocols, or `.agents/workflows/switchboard.md`, and that the orientation snippet parses
    `terminals` from the response. The defect is one curl flag; the assertion should be about that
    flag.
12. **Down and empty are distinguishable.** Two fixtures: board unreachable, and board up with
    `terminals: []`. Assert the run sheet's stated handling differs — the first reports the board
    down, the second reports nothing seated. This is the misdiagnosis the deleted paragraph used to
    guard by instruction.
13. **The resolve appears once.** Assert the orientation snippet occurs exactly once across the
    always-on preamble and is not repeated per branch protocol. It is pasted six times today, and
    repetition is what made agents skip it.

## Outstanding Questions

- **[user]** What are the menu's entries at launch? The plan's decomposition implies: *what's ready*,
  *run a batch now*, *watch an armed run*, *merge a finished feature*, *remote batch*. Planning,
  features and card moves already have their own skills and could be named by the menu or left to the
  launcher's existing closing list. Missions are absent until they exist.
- **[user]** Should the menu offer to *resume* a handed-off session? `handed off` is a real session
  state (Mission Control exited; queue and watch remain), and an operator returning to a handed-off
  pipeline currently has no documented door back in.
