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

**The one case that genuinely needs resident instructions.** Under `## Context Is Cleared Every Tick`,
every wake starts from a cleared terminal. On tick 40 there is no operator to ask, so the tick's rules
must be in the prompt. That is an argument for the *armed* branch carrying its protocol resident — not
for every entry carrying it.

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

## Dependencies

- **The front-door plan ships first.** It repairs `POST /orchestration/confirm` →
  `/mission-control/confirm` and the two legacy `.switchboard/orchestrator/` paths. Building a menu on
  top of a step 2 that cannot arm would bury the broken call one level deeper.
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
   | *(always)* | Role & Scope, Hard Rules, Port Discovery | 57 |
   | What's ready / board state | `## What Is Ready To Go` | 72 |
   | Run a batch now | Pre-flight, Handoff-or-arm, The handoff sequence | 154 |
   | Watch an armed run | The Tick, Signals, Context Is Cleared, Verify via Git, Messaging Leads | 228 |
   | Merge a finished feature | Merge-Back | 22 |
   | Remote batch | Remote intake | 19 |
   | *(reference)* | Transitions You Own, What You Never Do, Session File/Log/Completion | 50 |

   `switchboard-mission-control-http` (364) and `switchboard-contracts` (127) stay where they are and
   are named by the branches that need them, not inlined.

4. **Assemble per mode in `buildMissionControlKickoffPrompt`.** Replace the single concatenation with
   a mode-keyed one:

   | mode | receives |
   | :--- | :--- |
   | `interview` | runsheet (menu) + always-on preamble. **Not** the tick protocol. |
   | `stale-session` | the same, plus the existing stale-file instruction |
   | `resume` (armed) | the *watch an armed run* protocol only — **no menu**, because context is cleared and nobody is there to answer |

   The three-way branch already exists at `:11769-11783`; this keys the document to it rather than
   only the closing instruction.

5. **Rewrite launcher step 2** to hand off to the run sheet rather than to a persona. It stops saying
   "become the orchestrator" — a phrase that predates the rename and describes a role the design
   deliberately does not have (see `rename-the-orchestrator-to-mission-control.md`: *"the design is a
   monitor with escalation rights and no dispatch authority"*). Edit `.agents/workflows/switchboard.md`;
   `.claude/skills/switchboard/SKILL.md` is generated from it.

6. **Keep the menu honest by construction.** Every entry names a protocol path. A menu entry whose
   protocol is missing is worse than no entry — it is the `/orchestration/confirm` failure again, in a
   new file. Verification 2 asserts existence; change 8 keeps verbs out of the menu entirely.

7. **Leave the `no-persona` branch alone.** Its stand-by message is correct.

8. **Name protocols, not verbs.** The menu points at protocol files; `GET /catalog` and
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
8. **The menu states no endpoints.** Assert no `POST /` or `GET /` string appears in the run sheet
   outside the `## Port Discovery` health check. This is change 8 made enforceable.
9. **Launcher and mirror agree.** Assert `.claude/skills/switchboard/SKILL.md` matches
   `.agents/workflows/switchboard.md` modulo frontmatter.
10. **Both hosts.** All extension call sites and the three in `src/standalone/bootstrap.ts` share the
    builder, so assemble-per-mode is tested by calling the builder directly, host-agnostically. Note
    standalone passes no `deliveryMode` and therefore always receives the internal runsheet — carried
    forward as-is by this plan and recorded as a question, not fixed here.

## Outstanding Questions

- **[user]** What are the menu's entries at launch? The plan's decomposition implies: *what's ready*,
  *run a batch now*, *watch an armed run*, *merge a finished feature*, *remote batch*. Planning,
  features and card moves already have their own skills and could be named by the menu or left to the
  launcher's existing closing list. Missions are absent until they exist.
- **[user]** Should the menu offer to *resume* a handed-off session? `handed off` is a real session
  state (Mission Control exited; queue and watch remain), and an operator returning to a handed-off
  pipeline currently has no documented door back in.
