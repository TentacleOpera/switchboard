# Board Collapse 04 — Apply the Prompt and Agent Decisions

## Goal

Apply four of the sixteen signed conflict decisions, all concerning what an agent is told and how it is woken: Link-Up's mode, the completion directive, the Mission Control tick and the recovery ladder, and where an inbound tracker comment goes.

### Problem analysis

Four questions about agent instruction, each answered differently by two or three cards across different features. Left alone, whichever lands second undoes or contradicts the first. The decisions were taken by the operator on 2026-09-04 and are settled.

## Execution rules

1. Card operations go through the board or `.agents/skills/kanban_operations/*.js`. **Never SQL.**
2. Rescoping preserves the plan id and filename.
3. **No git working-tree operation** while this runs. Commits are fine — one per decision.
4. Deleting a card uses the board's delete path so the `.md` goes with it.
5. Do not touch `src/`.

## Metadata

- **Complexity:** 5
- **Tags:** board-hygiene, prompts, teams, trackers

## Proposed Changes

### Decision 2 — Link-Up has one mode

**Signed: standing orders are the only mode.** The addressee-inversion bug (a preset relayed verbatim so "your researcher" points at the researcher itself) exists only because Instant relays text verbatim. A one-shot message to another terminal already has two homes: the relay verb, and the Chat button added by *Chat button on terminal pane header*.

- Keep *Delete Link-Up's "Instant" Mode — Standing Orders Is the Only Mode*.
- Delete *Link-Up Role Presets Fire Through The Relay Path, Inverting Who The Instruction Is Addressed To*. Its finding — a preset carrying an instruction body must install as a standing order — is simply true once Standing is the only mode.
- Rescope *Bidirectional Link-Up — Both Terminals Get Instructions* to two standing orders per link, with no instant arm. Its plan already describes that as its standing-mode behaviour.
- The shipped `terminals.linkMode` setting is left orphaned on disk. No migration: a key with no reader is inert.
- Feature *Researcher Relationship* keeps its other two subtasks (the return path, retiring `/research/dispatch`); note in the feature file that the return path now serves Link-up-created and custom-team researchers, because the roster change in *Multi-Agent Planning Team* removes the last shipped team consumer of the `researcher` relationship.

### Decision 8 — where the completion directive lives

**Signed: the standing order carries the whole instruction, including "report the planId you were dispatched"; the dispatch prompt carries the planId as data**, which it already does as a header line.

- *Completion Directive Becomes a Standing Order, Not a Prompt-Injected Section* keeps ownership of the directive text and gains that one line. It lands **last** within the seat-release feature, because it names a prerequisite that does not exist at HEAD (the gate stopping lead-dispatched coders receiving the directive twice).
- *A column move orphans the dispatch holder* — rescope to its server-side fix only: `_runQueueDone` releases on `dispatched_terminal === from` alone, rather than requiring `dispatched_at` which a column move nulls. Delete its edits to the four completion-directive copies in `agentPromptBuilder.ts`. It lands **early**: it repairs 571 measured stranded rows.
- Neither plan now edits the prompt builder's directive copies twice.

### Decision 9 — no tick; one recovery ladder

**Signed: wake on transition, and one ladder at the head-prompt level.**

- Delete *Mission Control's hard-skip escalation must spend a bounded recovery budget first*. Its premise is the overnight tick loop with cleared context; no surviving plan builds on that loop, and an agent-held interval is precisely what this project has established cannot be durable.
- Rescope *Team lead escalation must exhaust cheap recovery before declaring a subtask blocked* to be the single ladder. Add a first rung: **verify the block against the seat's own log before acting**, because a `blocked` turn-end notice is frequently false. It owns the one edit to the KanbanProvider drive-block wording, so the acceptance-post plan does not race it.
- Rescope *Replace the Mission Control persona with a run sheet* so its resume branch carries one rung as text: when a lead reports blocked on a transition wake, re-dispatch with a bounded budget rather than skip permanently, and un-skip an awaiting-input card when the answer lands. No `progress.json` budget machinery.
- *A supervised mission has no supervision* is unchanged; it is the transition wake.

### Decision 10 — an inbound tracker comment goes to the instructions column

**Signed: the destination is the operator's explicit choice on the board, with Mission Control as the judgement layer** — never inferred from whether the card happened to be dispatched, and never relayed as raw remote text into a working seat's terminal.

- Feature *Trackers are for bulk queueing* is unchanged. Its stated order stands: the instructions column first, then retire the per-card comment trigger.
- Delete *A comment on a card cannot reach the seat holding the work*. Its own appended Collision section says its baseline was wrong and asks whether waking a seat belongs to the instructions column instead. It does.
- Delete *A team has no card to report to, though the comment primitive that would carry the report is built*. Its own header says "largely superseded — do not build this until the notification plan has shipped and been lived with".
- Feature *The Card Is A Two-Way Channel* is then left with one subtask, *The queue is invisible from a phone unless an agent remembers to narrate it*. That is outbound only — the host posting dispatch and completion comments on the synced card — and is complementary, not conflicting. Detach it to a loose plan in New and remove the feature.
- Before removing it, strike the feature file's two stale assertions, both already withdrawn in its subtasks: the "fourth event type" stall comment, and standing-orders "supplying the one missing piece".

## Verification Plan

- Four commits, one per decision.
- No active plan proposes an Instant mode for Link-Up, and none proposes deriving a mode from preset emptiness.
- Exactly one active plan edits the `COMPLETION REPORT` directive text.
- No active plan's premise is an interval tick with cleared context; exactly one active plan defines a recovery ladder.
- No active plan routes an inbound tracker comment to a terminal.
- Features *The Card Is A Two-Way Channel* no longer exists; its surviving plan is loose in New.
- `git status` shows only `.switchboard/` changes.
