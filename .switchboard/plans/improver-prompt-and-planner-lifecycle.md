# Improver Prompt Contract and Planner Lifecycle Protocol

## Goal

Define the two halves of the batch's behavioural contract: what an improver is told (append questions and research needs **into the plan file**, never ask in chat), and what the planner does when woken (read the plan, resolve or escalate, then kill the worker terminal).

### The problem

Batch workers are hidden terminals nobody is watching. An improver that hits a genuine ambiguity has three options and two of them are silent failures:

- **Ask in chat** — nobody is attached to that session. The question is never seen and the worker sits idle holding a live CLI session forever.
- **Guess silently** — the guess lands in the plan file, indistinguishable from a well-founded decision, and gets coded later.
- **Write the question into the plan file** — it survives, it is attributable to the plan it concerns, and it rides the existing plan-file-change signal to the planner for free.

Only the third works. But an agent will do the first two by default: asking the user is the normal, correct behaviour everywhere else, and nothing in the existing `improve-plan` skill tells it otherwise.

### Root cause

`improve-plan` was written for an attended, single-plan flow where a human is present to answer. Its output schema has no place to park an unresolved question, so an agent that has one either asks or buries it. Running that skill unattended, twenty at a time, turns a reasonable default into a silent-failure generator.

### Why questions-in-the-plan-file is the right channel

It needs no new endpoint, no inbox, and no polling. The plan file is already the deliverable, already write-once-at-the-end, and already the thing whose mtime advance signals completion. A question appended to it arrives at the planner through the same wake that reports the work — one mechanism, not two.

## Metadata

**Complexity:** 4
**Tags:** docs, backend, feature

## Reconcile Before Building

Check the current `.agents/skills/improve-plan/SKILL.md` section schema before adding to it, and confirm against the shipped notification wiring what the planner's wake message actually contains. Verify the **linkup** contract (unpushed) for how the planner receives messages and whether it can reply.

## Design

### 1. Plan file section for unresolved items

Add one required-when-non-empty section to the plan schema, written by the improver:

```markdown
## Outstanding Questions

- **[user]** <question that needs a human decision>
- **[research]** <thing needing external sources, with the specific question>
```

Rules:

- **Omit the section entirely when there is nothing outstanding.** Its presence is the signal; an empty-but-present section forces the planner to parse prose to decide whether it matters.
- Each item states the question **and** the assumption the improver proceeded under, so the plan stays coherent and codeable even before anyone answers.
- The improver continues and completes its work regardless. It never blocks waiting for an answer — there is nobody to answer.

The existing plan-authoring protocol requires problem analysis in or below `## Goal`; this section is additive and must not displace any required section.

### 2. Improver prompt contract

Every dispatched improver prompt carries:

> **Never ask questions in chat — no one is attached to this session.** If you need a user decision or external research, append it to the plan's `## Outstanding Questions` section, state the assumption you are proceeding under, and finish the work. Write the plan file once, at the end.
>
> You are improving exactly one plan: `<resolved planFile path>`. Do not create, modify, or delete any other file in `.switchboard/plans/`. Other workers are concurrently improving sibling plans in this same directory; touching their files will corrupt their work.

Resolve `planFile` from the plan record, never by synthesizing `<planId>.md`. The `dispatch-analysis` skill documents the three forms this field takes (absolute, workspace-relative, `file://` URI) and warns that a synthesized filename "will almost always miss" — here a miss means a worker that improves nothing while appearing to succeed.

The single-file directive matters because all workers share one working directory. That is a deliberate trade: worktrees would isolate them but plan files written in a worktree never reach the main root, so `GlobalPlanWatcherService` would never fire and nothing would land.

### 3. Planner protocol on wake

On each notification:

1. **Read only the named plan.** Never re-read the whole set, never read plans the planner was not woken about — the planner's context must stay flat as batch size grows.
2. **Check for `## Outstanding Questions`.**
   - **Absent** → the plan is done. Kill the named worker terminal via `POST /terminals/kill`. Optionally promote the card (see below).
   - **Present, `[research]` items** → dispatch research if a researcher is available, otherwise collect for the digest. Do **not** kill the worker — leaving it alive keeps the option of re-tasking it once the answer exists.
   - **Present, `[user]` items** → collect for the human. Do not kill the worker.
3. **Never reply to a worker expecting an answer.** Workers do not wait; anything a worker needs must arrive as a fresh instruction, not a response.
4. **Report at the end**, not per wake — one digest naming completed plans, plans with open questions, and workers left alive and why.

### 4. Card promotion and the autoban interlock

If the planner also promotes completed plans `CREATED → PLAN REVIEWED`, move them via `POST /kanban/move` — the API path a human's click takes — never SQL.

**`PLAN REVIEWED` ships with `autobanEnabled: true`** (`agentConfig.ts:135`), and the autoban engine wakes on arrivals via `db.onColumnChanged` → `_notifyAutobanWatchArrival` (`TaskViewerProvider.ts:11117`). Promoting 20 improved plans therefore fires 20 arrivals, and if autoban is armed, *"improve 20 plans" silently becomes "start coding 20 plans"* — a far larger and more expensive action than was asked for, billed to the coding roles rather than the cheap improver roles.

`POST /oversight/start` already guards exactly this with a `409` "while autoban/orchestration automation is armed (double-dispatch guard)." **Enforce the same check where the move happens, in the move path — not only in the planner's prompt.** A prompt-level rule is guidance an agent can forget; the hazard is expensive enough to warrant a code-level guard.

If promotion is deferred to the user instead, none of this applies — say so explicitly in the digest so the user knows the cards are still in Created.

### 5. Skill and docs

Update `.agents/skills/improve-plan/SKILL.md` with the `## Outstanding Questions` schema and the never-ask-in-chat rule, gated to unattended runs so the attended single-plan flow keeps its normal behaviour. Document the batch surface and the planner protocol in `switchboard-orchestration` (invocation) and the behavioural rules in `switchboard-contracts` (behaviour) — the two skills are explicitly not to be crossed.

## Verification Plan

1. **Unit — prompt contract.** Every generated improver prompt contains the never-ask-in-chat directive, the append-to-plan instruction, the single-file scope directive, and exactly one resolved plan path.
2. **Unit — planFile resolution.** All three `planFile` forms resolve to a readable path; assert none is synthesized from the planId.
3. **Unit — section detection.** A plan with no `## Outstanding Questions` reads as done; one with `[user]` or `[research]` items reads as blocked. Assert an empty-but-present section is treated as a schema violation, not as "done."
4. **Unit — kill only when clean.** Worker terminals are killed on the no-questions path only; assert workers with outstanding items survive.
5. **Unit — planner reads one plan.** On a wake naming plan X, assert exactly one plan file is read and no board-wide query is issued.
6. **Unit — autoban interlock.** With autoban armed on `PLAN REVIEWED`, assert the move path refuses with `409` and the card stays in Created. Assert the guard lives in the move path, not only in prompt text.
7. **Unit — promotion via API.** Assert moves go through the kanban move service; assert no direct `kanban_column` UPDATE.
8. **Integration — concurrent writes.** Five workers improving five plans in one directory: assert all five files are well-formed and none contains another's content.
9. **Manual (VSIX).** Dispatch 4 improvers with one prompt seeded to produce an outstanding question. Confirm: 3 terminals are killed, the 4th survives, its question appears in that plan's `## Outstanding Questions`, and the digest names it.

## Dependencies

- **Hidden Terminal Creation** (`hidden-terminal-create-and-provider-mix.md`) — terminal creation and `POST /terminals/kill`.
- **Plan-File Updates Notify the Planner** (`plan-update-notifies-planner.md`) — the wake this protocol responds to.
