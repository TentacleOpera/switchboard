# Plan-File Updates Notify the Planner Terminal

## Goal

When a batch worker finishes writing its revised plan file, push a message to the planner terminal naming the plan that changed — so the planner reacts to completion as an event instead of polling for it.

### The problem

A planner that dispatches 20 improvers has no way to learn when any of them finishes. Every available option today is bad:

- **Poll the filesystem or the board** — costs a model turn per check, on the planner's subscription, repeated across the whole batch. For a feature whose entire motivation is spending less, a babysitting loop is the wrong shape.
- **Watch the terminals** — the workers are hidden by design, and interactive shells never exit, so there is no process-level completion signal to watch.
- **Have workers report in themselves** — every worker must then know the planner's address and remember to use it, and a worker that dies mid-run reports nothing.

### Root cause

The completion signal already exists and is already reliable; it just has no route to the planner. `GlobalPlanWatcherService` emits `onPlanDiscovered` (`src/services/GlobalPlanWatcherService.ts:44-48`) on plan-file changes, and `OversightPassService.attachWatcher()` (line 147) already consumes exactly this signal to drive its state machine. The established behavior contract (`switchboard-contracts`) is that **completion = plan-file mtime advance** and **plan files are write-once-at-the-end** — which makes a single file-change event a clean, non-chatty "this worker is done" marker.

What is missing is a delivery path from that watcher event to a specific terminal. That path is what the unpushed **linkup** work provides.

### Why this is the right signal

It is emitted by the extension, not by the worker, so it fires whether or not the worker behaves well. It fires once per plan because of the write-once contract. And it carries the one fact the planner needs — *which* plan changed — with no payload the planner has to pay to parse.

## Metadata

**Complexity:** 4
**Tags:** backend, reliability, feature

## Reconcile Before Building

This plan depends on **linkup** (terminal-to-terminal messaging), which exists only in unpushed local work — **no trace of it is in this branch**. Everything below assumes linkup provides: a stable terminal identifier, the ability to address a named terminal from extension code, and delivery of a message as a prompt into that terminal's session.

**Verify all three before building.** If linkup's model differs — for example if it is webview-mediated, or peer-to-peer between terminals with no extension-side send — the wiring changes shape and this plan must be re-cut against what actually exists. Do not build a second messaging path alongside it.

## Design

### Wiring

Subscribe to `GlobalPlanWatcherService.onPlanDiscovered`, mirroring how `OversightPassService.attachWatcher` consumes it. On a change to a plan that belongs to an active batch, send a linkup message to that batch's planner terminal.

### Scoping — the part that will go wrong if rushed

`onPlanDiscovered` fires for **every** plan-file change in the workspace, including the user editing a plan by hand, tracker syncs, and unrelated agents. Without scoping, a planner mid-batch gets woken by edits that have nothing to do with it and starts reading plans it was never asked about.

Register a batch as `{ plannerTerminal, planIds[] }` when it is dispatched, and notify only on changes to plans in that set. Ignore changes to plans not in any active batch — that is the pre-existing behavior and must stay unchanged. When a plan is claimed by no active batch, no message is sent.

Deregister a plan from the batch once notified, so a later hand-edit of the same file does not re-wake the planner about work that is already done.

### Message content

Keep it minimal — the message becomes prompt text in the planner's session and is billed to the planner's subscription every time:

> Plan `<planId>` (`<topic>`) was updated by its improver. Read it, resolve or escalate any outstanding questions, then kill terminal `<terminalName>`.

Name the plan, its file path, and the worker terminal to kill. **Do not include the plan body** — the planner reads the file itself, and inlining bodies makes the planner's context grow with batch size.

### Delivery discipline

- **Debounce per plan.** A worker that writes more than once (or an editor that emits multiple change events for one save) must produce one message, not several. Collapse events per plan within a short window.
- **Deliver at most once per plan per batch.** Combined with deregistration, this is what stops a wake loop where the planner's own actions re-trigger notifications.
- **A worker that never writes never notifies.** Accept this: the batch is intentionally not monitored, so a silently-failed improver leaves its card untouched and its terminal alive. That is a visible, inspectable end state rather than a lost one. Do not add a timeout sweep to compensate — the user has explicitly declined monitoring machinery, and a stalled worker's terminal is still there to look at.
- **Delivery is best-effort.** If the planner terminal is gone, log and drop; never throw into the watcher, which would break plan ingestion for the whole workspace.

### Cross-workspace safety

`onPlanDiscovered` carries a workspace root. Notify only the planner registered for that workspace — a multi-root user with two batches must not have one workspace's completions wake the other's planner.

## Verification Plan

1. **Unit — scoped notification.** Change a plan in an active batch → one message to that batch's planner. Change a plan not in any batch → **zero** messages.
2. **Unit — message content.** Assert the message names planId, topic, plan file path, and worker terminal name, and contains no plan body.
3. **Unit — debounce.** Three change events for one plan inside the debounce window produce exactly one message.
4. **Unit — once per batch.** After notification and deregistration, a further change to the same plan produces no second message.
5. **Unit — no worker write, no message.** A batch where one worker never writes: assert no message for that plan and assert no timeout-driven message is synthesized.
6. **Unit — planner gone.** With the planner terminal killed, assert the send failure is logged, swallowed, and `onPlanDiscovered` still completes plan ingestion normally.
7. **Unit — multi-root isolation.** Two workspaces with two batches: assert each planner receives only its own workspace's notifications.
8. **Regression — ingestion untouched.** Existing `GlobalPlanWatcherService` and oversight tests pass unmodified; assert the new subscriber cannot throw into the watcher.
9. **Manual (VSIX).** Dispatch 3 improvers, then hand-edit a fourth unrelated plan. Confirm the planner is woken exactly three times, never for the hand-edited plan, and that each message names the right terminal.

## Dependencies

- **Hidden Terminal Creation** (`hidden-terminal-create-and-provider-mix.md`) — supplies the terminal identifiers used to register a batch and to tell the planner which terminal to kill.
- **linkup** (unpushed) — the message transport. Verify its contract before building.
