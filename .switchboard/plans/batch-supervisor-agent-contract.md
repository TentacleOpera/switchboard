# Batch Supervisor Contract: Dispatch, Poll, Digest — Without Reading Plans

## Goal

Document the batch surface for agents and define the supervising planner's operating contract: it dispatches by plan ID, polls status in short turns, and writes a digest — and never reads a plan body. This is what makes the supervisor's context cost flat with respect to batch size.

### The problem

An agent asked to "improve all the plans in Created" will, by default, read all of them. At 20 plans that is a context blowout before a single improver has been spawned, and it duplicates work the improvers are about to do anyway. The failure is quiet: the supervisor still produces a plausible-looking summary, just after burning its window and with a stale view of files the improvers rewrote underneath it.

### Root cause

Two gaps, both documentation-shaped:

1. **The endpoints are undiscoverable.** The `switchboard-orchestration` skill is the invocation authority — "the **complete** HTTP contract for driving Switchboard from outside the VS Code webview." Endpoints absent from it do not exist as far as an external agent is concerned. The batch endpoints will be absent.
2. **Nothing tells the supervisor not to read.** The batch status payload is deliberately body-free, but an agent with filesystem access will read plan files anyway unless the contract explicitly forbids it and explains what to use instead.

This plan is small but is not a documentation afterthought — the supervising planner is the interface to the entire feature. The user's model is "direct them all to the planner"; the planner's contract is the product.

## Metadata

**Complexity:** 3
**Tags:** docs, cli

## Reconcile Before Building

Confirm the final endpoint paths, payload field names, and per-agent state vocabulary against the shipped implementation before writing any of this down. Documentation that drifts from the endpoints is worse than none — agents follow it literally and fail in ways that look like server bugs. Verify against `GET /catalog` and the handlers in `LocalApiServer.ts`, not against the sibling plan files.

## Design

### 1. Extend the `switchboard-orchestration` skill

Add a section covering the batch surface, matching the existing house style of §4a (Oversight pass) — endpoint table, semantics prose, runnable `curl` block.

Content requirements:

- **Endpoint table** — `POST /agents/spawn-batch`, `GET /agents/batch/status`, `POST /agents/batch/stop`, `POST /agents/batch/report`, with body/query and purpose columns.
- **Headless execution model** — batch agents run as child processes, do **not** appear in the terminals UI, are absent from `runtime.terminals`, and cannot be targeted by any dispatch endpoint. State this plainly: an agent reading the existing docs will otherwise assume the `/kanban/dispatch` "live terminal agent" model applies and look for terminals that will never exist.
- **The report-back channel, from both sides** — how a batch agent files a question/research/blocker (`POST /agents/batch/report`, non-blocking, best-effort, file-then-continue-under-a-stated-assumption), and how the supervisor consumes it (in `reports[]` on the status it already polls). Include the prohibition on batch agents calling `/research/dispatch` directly, and why: it needs a live `researcher` terminal and returns `{dispatched: false}` rather than spawning, which from a headless agent is a silent drop.
- **Per-agent state vocabulary** — `queued | running | completed | exited | failed | stuck`, and explicitly that **`exited` is not `completed`**: the process ended without the plan file's mtime advancing, so no work landed. Any agent reading this doc must be able to tell a no-op from a success.
- **`stuck` is report-only** — it does not kill the terminal, free the slot, or halt the batch.
- **Failure isolation** — one failed agent does not halt a batch. State this in contrast to the oversight pass's documented halt-on-failure, since a reader coming from §4a will otherwise carry the wrong assumption across.
- **Concurrency** — capped pool with backfill, configurable per batch, defaulting to the workspace setting.
- **Runnable `curl` examples** for spawn, poll, and stop.
- **Cross-reference** to §4a explaining when to reach for which: oversight for a serial, review-gated conveyor over a column; batch for wide independent work where per-item failure must not stop the rest.

### 2. Add behavior contracts to the `switchboard-contracts` skill

That skill is the *behavior* authority (invocation lives in `switchboard-orchestration`; the two are explicitly not to be crossed). Add:

- **Batch completion = plan-file mtime advance**, consistent with the existing completion contract. A batch agent that exits without advancing its plan's mtime did not complete.
- **Non-plan refs have no completion signal** — they terminate at `exited` and are never reported `completed`.
- **Batch state files are extension-written only** — agents read `.switchboard/agent-batches/`, never write it, mirroring the existing rule for `oversight-state.md` / `oversight-log.md`.
- **Batches never re-dispatch on resume.**

### 3. The supervisor operating contract

Add to the skill surface (and to the mass-improve dispatch prompt) an explicit supervisor protocol:

1. **Resolve IDs only.** Get the target set from `GET /kanban/plans?column=CREATED` or the board action's resolved set. Do **not** call `GET /kanban/plan?planId=` — that endpoint returns the plan's full file content (`.data.content`), which is exactly what must not enter the supervisor's context.
2. **Dispatch by ID.** Post the batch with refs and prompts. Never inline plan bodies into the batch payload.
3. **Poll in short turns.** Call `GET /agents/batch/status` and read `counts` first; only read the arrays when something needs naming. Keep each polling turn short — the point is a small, repeated context, not one long-lived one.
4. **Triage `reports[]` on every poll.** This is the supervisor's only genuinely active duty, and the reason a supervisor exists at all rather than a progress bar. Headless agents cannot wait for answers, so every report is already-filed history, not a live prompt — triage it accordingly:
   - `question` — if answerable and still relevant, answer it in the digest or, when it invalidates the agent's stated assumption, queue that plan for a re-run after the batch. Do not attempt to reply to a running agent; there is no channel back into a headless process.
   - `research` — decide whether to forward to `/research/dispatch` (only meaningful if a live `researcher` terminal exists) or surface it to the human. Never assume filing equals dispatching.
   - `blocker` — name it in the digest as needing a human. Do not attempt an automated fix.
   - `note` — record; no action.
5. **Digest from status, not from files.** The final summary reports counts, per-plan outcomes by title, durations, every filed report, and specifically names every `exited`, `failed`, `timedOut`, and `stuck` agent as needing attention. Include the `providers` breakdown so the user can confirm which subscription the batch actually billed — that verification is the point of headless dispatch and belongs in the digest, not in the user's head. If the supervisor cannot describe an outcome from the status payload alone, that is a gap in the status payload to be fixed there — not a licence to read plan files.
6. **Never read plan bodies. Never write plan files. Never move cards.** Promotion is the batch engine's job; a supervisor moving cards races the engine.

State the reason inline, not just the rule: reading N plan bodies makes supervisor context grow with batch size, which is the one thing this architecture exists to avoid.

### 4. Register in the skill catalogue

Update the skills table in `CLAUDE.md` / `AGENTS.md` if a new skill entry is warranted, and confirm `GET /catalog` advertises the new endpoints so external tools discover them without reading source.

## Verification Plan

1. **Doc-vs-code parity test.** Extend the existing prompt/skill sync test pattern (see `src/test/prompt-split-guidance-sync.test.js`) to assert every batch endpoint path documented in `switchboard-orchestration/SKILL.md` exists as a route in `LocalApiServer.ts`, and vice versa. This is the test that keeps the docs honest as the endpoints evolve.
2. **State-vocabulary parity.** Assert the six state names documented in the skill match the state union in the batch service exactly — no extras, none missing.
3. **Catalog coverage.** Assert `GET /catalog` includes the batch endpoints.
4. **Curl examples are well-formed.** Parse the JSON bodies in the skill's `curl` blocks; assert each is valid JSON and its keys are a subset of the handler's accepted fields.
5. **Prompt directive present.** Assert the mass-improve dispatch prompt contains the never-read-plan-bodies directive.
6. **Report triage documented.** Assert the skill documents all four report types with a defined supervisor action for each, and states that no channel exists back into a running headless agent.
7. **Manual — read-only trace.** Run a supervised batch end to end, with one agent instructed to file a `question` and one to file a `research` report. Inspect the supervisor's tool calls: assert zero `GET /kanban/plan?planId=` calls and zero plan-file reads; assert the digest names the intentionally-failed agent, both reports, and the `providers` breakdown.

## Dependencies

- **Agent Batch Spawn Primitive** (`agent-batch-spawn-primitive.md`)
- **Agent Batch Tracking** (`agent-batch-tracking-and-status.md`) — the state vocabulary and status payload documented here are defined there.
- **Mass Plan Improvement** (`mass-improve-created-column.md`) — the supervisor prompt directive lands in that plan's dispatch path.

Write this **last**, against the shipped implementation.
