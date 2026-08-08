# Mass Plan Improvement: Fan Out `improve-plan` Across the Created Column

## Goal

Add the first real consumer of the agent batch primitive: select the loose plans a user can actually see in the Created column, spawn one `improve-plan` agent per plan under a concurrency cap, and auto-promote each plan to **PLAN REVIEWED** as it completes.

### The problem

Improving 20 plans today means 20 manual dispatches, or a serial `/oversight/start` sweep that processes them one at a time with a WIP-1 coding lane. Neither matches how the work actually decomposes: improving plan A tells you nothing about plan B, so the work is embarrassingly parallel and is being run serially.

### Root cause

Plan improvement was only ever wired for two shapes — one plan at a time (`improve-plan`, extension-dispatched) or one feature's subtasks (`improve-feature`, one agent handling N sequentially). There is no column-scoped, N-wide path, because until the batch spawn primitive there was no way to create N agents.

### Why no worktrees

Improving a plan rewrites exactly one file in `.switchboard/plans/`. Git isolation buys nothing here and actively breaks the pipeline: plan files written inside a worktree do not exist in the main root, and `GlobalPlanWatcherService` watches the main root — so the mtime completion signal would never fire and the improvements would not land until merge. Twenty improvers sharing the main workspace root is safe **provided each is hard-bound to exactly one plan file**. That is a directive-and-verification problem, not an isolation problem, and this plan treats it as such.

## Metadata

**Complexity:** 6
**Tags:** backend, ui, feature

## Reconcile Before Building

Unpushed local work may already have added a mass-improve action. Before coding, check the board's Created-column actions in `src/webview/kanban.html` and grep `TaskViewerProvider.ts` for existing improve-batch handling. Extend what exists rather than adding a second, competing button.

## Design

### Selection — reuse `_visibleColumnCards`, do not reinvent it

`KanbanProvider._visibleColumnCards(workspaceRoot, column)` (`src/services/KanbanProvider.ts:471`) already implements exactly the required rule:

```ts
this._lastCards.filter(card =>
    card.workspaceRoot === workspaceRoot && card.column === column && !card.featureId
)
```

Its doc comment (lines 455-470) records why: a feature's subtasks carry their own `kanban_column` independent of their feature's column, and the board renders `displayCards.filter(card => !card.featureId)`. Without the `!card.featureId` exclusion, a subtask whose column happens to be CREATED gets swept in even though the user only sees it nested under a feature that may live in BACKLOG. **This exact divergence is what made "Advance All" on CREATED dispatch a BACKLOG feature's subtasks instead of the loose plans the user could see.** Mass-improve is the same shape of operation and will reproduce the same bug if it builds its own selection.

Consequences to honor:

- **Backlog is not swept.** `BACKLOG` is a distinct stored `kanban_column` value (`agentConfig.ts:151` marks it `displayModeOf: 'CREATED'` for display; `ClickUpSyncService.ts:3277` writes it as its own value). Querying `CREATED` therefore excludes Backlog cards, which matches the user's intent — parked work stays parked.
- **Feature containers and feature subtasks are excluded.** Improving a feature's subtasks is `improve-feature`'s job.
- **WYSIWYG rule:** the batch must improve exactly the set of cards visible in the Created column, no more.

Surface the resolved count before spawning (`"Improving 14 plans in Created"`) so a mismatch with what the user sees is caught immediately, not after 14 agents have run.

### Per-agent prompt

Build one prompt per plan from the `improve-plan` skill (`.agents/skills/improve-plan/SKILL.md`), routed through the existing `agentPromptBuilder` rather than string-concatenated at the call site, so subagent policy, constitution injection, and add-ons apply consistently.

Every prompt MUST carry a hard file-scope directive, since all agents share one working directory:

> You are improving exactly one plan: `<resolved planFile path>`. Do not create, read-modify, or delete any other file in `.switchboard/plans/`. Other agents are concurrently improving sibling plans in this same directory; touching their files will corrupt their work.

Resolve `planFile` from the plan record, never by synthesizing `<planId>.md`. The `dispatch-analysis` skill documents the three forms this field takes (absolute, workspace-relative, `file://` URI) and warns that a synthesized filename "will almost always miss, and a miss silently drops the plan." The same hazard applies here, with worse consequences: a miss means an agent improves nothing while reporting success.

Because the agents are **headless**, the prompt must also carry a report-back contract — a headless improver has no interlocutor and cannot ask anything interactively. Its two failure modes without this are equally bad: hang waiting for input nobody will provide, or guess and write the guess into a plan file.

> If you hit an ambiguity you cannot resolve from the plan and the codebase, file it via `POST /agents/batch/report` (`type: "question"`, or `"research"` for something needing external sources) with your `batchId` and `ref`, then continue under an explicitly stated assumption and record that assumption in the plan. Do not stop to wait for an answer — no one is attached to this session. Never ask an interactive question.

Do **not** have improvers call `/research/dispatch` directly: it requires a live `researcher` terminal and returns `{dispatched: false}` rather than spawning one, which from a headless agent is a silent drop. File the request; the supervisor routes it.

### Provider selection

The batch's `role` selects the CLI, the subscription, and therefore the bill. Expose the role choice in the board action, defaulting to a configured bulk-improvement role rather than a Claude-billed one — routing high-volume, low-judgement work to a cheaper provider is the primary motivation for headless dispatch, and a default that quietly bills Claude credits defeats it.

Show the role's resolved `label` and the plan count in the action before dispatch ("Improve 14 plans via Gemini CLI (personal sub), 3 at a time"), so the cost target is visible at the moment of spending rather than discoverable afterward. Carry the same `providers` breakdown into the digest.

### Concurrency

Default to the `switchboard.agentBatch.defaultConcurrency` setting; expose an override in the board action so the user can widen or narrow per run. Twenty simultaneous agents will hit provider rate limits and fail mid-write; a capped pool with backfill finishes in near-identical wall-clock and degrades gracefully.

Note that rate limits are now **per provider**: a batch split across two roles has two independent budgets, and a single cap applied across the whole batch will throttle the cheap provider to protect a limit it does not share. Treat per-role concurrency as a follow-up if mixed-provider batches become common; a single cap is acceptable for the single-role case this plan delivers.

### Auto-promotion to PLAN REVIEWED

On each agent's **`completed`** transition (plan-file mtime advanced — see the batch tracking plan), move that plan `CREATED → PLAN REVIEWED` via the existing `POST /kanban/move` path, which the orchestration skill establishes as the sanctioned mechanism ("the API path a human's click takes"). **Never write `kanban_column` via SQL.**

Promotion rules:

- **Promote only on `completed`.** An agent that reaches `exited` (process ended, no mtime advance) has produced nothing; promoting it would push an unimproved plan into Planned and from there into `dispatch-analysis`, silently laundering a no-op into a dispatch candidate. `exited`, `failed`, and `stuck` agents leave their card in Created.
- **Promote incrementally**, as each agent completes — not in one sweep at batch end. A batch stopped or interrupted halfway should leave completed plans promoted and the rest untouched.
- **Promotion failure is isolated.** A failed move is reported for that plan and does not stop the batch or affect other promotions.

This makes the chain Created → (mass improve) → PLAN REVIEWED → `dispatch-analysis` → DISPATCH fully automatic, which is the intended end state.

#### Automation interlock (do not skip)

`PLAN REVIEWED` ships with `autobanEnabled: true` (`agentConfig.ts:135`), and the autoban engine subscribes to `db.onColumnChanged`, waking on arrivals via `_notifyAutobanWatchArrival` (`TaskViewerProvider.ts:11117`). Promoting N plans into that column therefore fires N arrival notifications. **If autoban is armed, a "improve 20 plans" request silently becomes "start coding 20 plans"** — a far larger and more expensive action than the user asked for, and one that spends on the *coding* provider rather than the cheap improvement provider the batch was configured for.

`POST /oversight/start` already guards precisely this hazard: it returns `409` "while autoban/orchestration automation is armed (double-dispatch guard)." Mass-improve must carry the same interlock:

- **Refuse to start with `409` when autoban or orchestration automation is armed for the target column**, with a message naming what is armed. Mirror the oversight guard's shape rather than inventing a second convention.
- Because promotion here is incremental rather than a single end-of-batch sweep, also **re-check the interlock before each promotion** — automation can be armed by the user midway through a long batch, and a check performed only at start would miss it.
- If the interlock trips mid-batch, stop promoting, leave the remaining improved plans in Created, and report which plans were promoted and which were held. Improvements are never lost — they are already written to the plan files — only the column move is withheld.

Document the interaction in the digest: a user who armed autoban deliberately and *wants* the chain to continue should see plainly that it did.

### Board action

Add an action on the Created column ("Improve All") that resolves the visible set, shows the count and the concurrency it will use, and posts the batch. Per the project's standing rule, this button **must not** gate on a `confirm()` — `window.confirm()` is a silent no-op in VS Code webviews and would make the button do literally nothing. Showing the resolved count in the action's own affordance is the safeguard.

## Verification Plan

1. **Unit — selection parity.** Seed loose CREATED plans, a BACKLOG plan, a feature container in CREATED, and a feature subtask whose column is CREATED but whose feature is in BACKLOG. Assert the batch set equals exactly the loose CREATED plans, and specifically that the BACKLOG feature's subtask is excluded. This is a direct regression test for the documented "Advance All" bug.
2. **Unit — selection delegates.** Assert the resolver calls `_visibleColumnCards` rather than filtering `_lastCards` inline.
3. **Unit — planFile resolution.** Feed all three `planFile` forms (absolute, relative, `file://`); assert each resolves to a readable path and none is synthesized from the planId.
4. **Unit — file-scope directive.** Assert every generated prompt names exactly one plan file and includes the do-not-touch-siblings directive.
4b. **Unit — report-back directive.** Assert every generated prompt includes the file-a-report-and-continue contract, the never-ask-interactively directive, and the agent's own `batchId` and `ref`.
4c. **Unit — no direct research dispatch.** Assert no generated prompt instructs the agent to call `/research/dispatch`.
4d. **Unit — provider surfaced.** Assert the board action displays the resolved role `label` and plan count before dispatch, and that the digest carries the `providers` breakdown.
5. **Unit — promote only on completed.** Agents reaching `completed` are moved to PLAN REVIEWED; agents reaching `exited`, `failed`, or `stuck` remain in CREATED. Assert `exited` never promotes.
6. **Unit — incremental promotion.** Complete 2 of 5 agents, stop the batch, assert exactly 2 cards moved.
7. **Unit — promotion via API, not SQL.** Assert the move path is the kanban move service; assert no direct `kanban_column` UPDATE is issued.
7b. **Unit — autoban interlock at start.** With autoban armed on `PLAN REVIEWED`, assert the batch refuses to start with `409` and a message naming what is armed, and that zero agents spawn.
7c. **Unit — autoban interlock mid-batch.** Start with automation disarmed, arm it after two promotions, assert promotions 3+ are held, the batch still completes its improvements, and the digest reports promoted-vs-held.
7d. **Unit — arrival amplification.** Promote 5 plans and assert exactly 5 `onColumnChanged` arrivals fire — no duplicate notifications per plan (a per-plan double-notify would double-wake autoban).
8. **Unit — no confirm gate.** Static assertion that the Created-column action introduces no `confirm(`/`window.confirm(` call, matching the existing kanban confirm-gate regression tests.
9. **Integration — concurrent writes.** Run 5 agents against 5 scratch plans in one directory; assert all 5 files are individually well-formed afterward and no file contains content from a sibling plan.
10. **Manual (VSIX).** With ~8 loose plans in Created plus one Backlog card and one feature, click Improve All at concurrency 3. Confirm: only the 8 loose plans are picked up, at most 3 terminals run at once, cards move to Planned one at a time as they finish, and the Backlog card and feature are untouched.

## Dependencies

- **Agent Batch Spawn Primitive** (`agent-batch-spawn-primitive.md`)
- **Agent Batch Tracking** (`agent-batch-tracking-and-status.md`) — auto-promotion keys off the `completed` vs `exited` distinction defined there. Without it, this plan cannot tell an improved plan from a no-op.
